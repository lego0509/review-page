export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import OpenAI from 'openai';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

/**
 * ---------------------------
 * このエンドポイントの責務
 * ---------------------------
 * - embedding_jobs の queued / failed を拾って embedding を作る
 * - course_review_bodies の本文から SHA256(content_hash) を作る
 * - course_review_embeddings を upsert する（冪等）
 * - embedding_jobs を done / failed に更新し、失敗理由を残す
 *
 * rollups（avg/summary）は一切触らない。責務分離。
 */

/** 1回の実行で処理する最大件数（重いので小さめから） */
const MAX_JOBS_PER_RUN = 50;

/** OpenAI embeddings をまとめて投げるサイズ（呼び出し回数削減） */
const EMBEDDING_BATCH_SIZE = 16;

/** 二重起動や途中落ち対策：この分以上ロックが古ければ再取得可能 */
const LOCK_STALE_MINUTES = 15;

// -------- 共通 util --------

function supabaseErrorToJson(err: any) {
  if (!err) return null;
  return { message: err.message, code: err.code, details: err.details, hint: err.hint };
}

function sha256Hex(text: string) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function chunk<T>(arr: T[], size: number) {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function requireEnv(name: string, value?: string | null) {
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/** バッチ用の簡易認証（GitHub Actions からの叩き専用） */
function checkBatchAuth(req: Request) {
  const expected = requireEnv('BATCH_TOKEN', process.env.BATCH_TOKEN);
  const got = req.headers.get('x-batch-token') || '';
  return got === expected;
}

function getOpenAIForEmbeddings() {
  // 分けたい場合：OPENAI_API_KEY_EMBEDDINGS を設定すればそちら優先
  const apiKey =
    process.env.OPENAI_API_KEY_EMBEDDINGS || process.env.OPENAI_API_KEY || '';
  requireEnv('OPENAI_API_KEY(or _EMBEDDINGS)', apiKey);
  return new OpenAI({ apiKey });
}

function getEmbeddingModel() {
  return process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
}

// -------- DB 型（必要最低限） --------

type JobRow = {
  review_id: string;
  status: 'queued' | 'processing' | 'done' | 'failed';
  attempt_count: number;
  locked_at: string | null;
  locked_by: string | null;
};

type BodyRow = {
  review_id: string;
  body_main: string;
};

type EmbMetaRow = {
  review_id: string;
  content_hash: string | null;
};

// -------- メイン --------

export async function POST(req: Request) {
  const startedAt = Date.now();
  const runner =
    req.headers.get('x-batch-runner') ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    'unknown-runner';

  try {
    // 1) 認証。これが無いと誰でも叩けてOpenAI課金が燃える。
    if (!checkBatchAuth(req)) {
      return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
    }

    const openai = getOpenAIForEmbeddings();
    const model = getEmbeddingModel();

    // 2) まず、処理対象の job を拾う（queued/failed）
    //    lockが古いものは再取得してよい（途中で落ちたケース）
    const staleBefore = new Date(Date.now() - LOCK_STALE_MINUTES * 60 * 1000).toISOString();

    const { data: jobs, error: jobsErr } = await supabaseAdmin
      .from('embedding_jobs')
      .select('review_id,status,attempt_count,locked_at,locked_by')
      .in('status', ['queued', 'failed'])
      // locked_at が null か、古い（stale）ものだけ
      .or(`locked_at.is.null,locked_at.lt.${staleBefore}`)
      .order('updated_at', { ascending: true })
      .limit(MAX_JOBS_PER_RUN);

    if (jobsErr) {
      return NextResponse.json(
        { ok: false, error: 'failed to fetch embedding_jobs', details: supabaseErrorToJson(jobsErr) },
        { status: 500 }
      );
    }

    const picked = (jobs || []) as JobRow[];

    if (picked.length === 0) {
      return NextResponse.json({
        ok: true,
        message: 'no embedding jobs',
        runner,
        elapsed_ms: Date.now() - startedAt,
        counts: { picked: 0, done: 0, skipped: 0, failed: 0 },
      });
    }

    const reviewIds = picked.map((j) => j.review_id);

    // 3) 先にロックを取る（processingへ）
    //    完全な排他ロックではないが、同時実行が起きても被害を減らす
    {
      const nowIso = new Date().toISOString();
      const { error: lockErr } = await supabaseAdmin
        .from('embedding_jobs')
        .update({
          status: 'processing',
          locked_at: nowIso,
          locked_by: runner,
          updated_at: nowIso,
        })
        .in('review_id', reviewIds)
        .in('status', ['queued', 'failed']);

      if (lockErr) {
        return NextResponse.json(
          { ok: false, error: 'failed to lock embedding_jobs', details: supabaseErrorToJson(lockErr) },
          { status: 500 }
        );
      }
    }

    // 4) 本文をまとめて取得
    const bodyMap = new Map<string, string>();
    for (const ids of chunk(reviewIds, 200)) {
      const { data: bodies, error: bodiesErr } = await supabaseAdmin
        .from('course_review_bodies')
        .select('review_id,body_main')
        .in('review_id', ids);

      if (bodiesErr) {
        return NextResponse.json(
          { ok: false, error: 'failed to fetch course_review_bodies', details: supabaseErrorToJson(bodiesErr) },
          { status: 500 }
        );
      }

      for (const b of (bodies || []) as BodyRow[]) {
        bodyMap.set(b.review_id, b.body_main);
      }
    }

    // 5) 既存 embedding の content_hash をまとめて取得（本文が変わってないならスキップ可能）
    const hashMap = new Map<string, string | null>();
    for (const ids of chunk(reviewIds, 200)) {
      const { data: metas, error: metaErr } = await supabaseAdmin
        .from('course_review_embeddings')
        .select('review_id,content_hash')
        .in('review_id', ids);

      if (metaErr) {
        return NextResponse.json(
          { ok: false, error: 'failed to fetch course_review_embeddings meta', details: supabaseErrorToJson(metaErr) },
          { status: 500 }
        );
      }

      for (const m of (metas || []) as EmbMetaRow[]) {
        hashMap.set(m.review_id, m.content_hash ?? null);
      }
    }

    // 6) embeddingが必要なものを抽出
    //    - body が無い → 不整合。failedにして理由を残す
    //    - content_hash一致 → embeddingは最新。doneにしてスキップ
    const need: { review_id: string; body: string; hash: string; attempt_count: number }[] = [];
    const toDoneSkip: string[] = [];
    const toFailMissingBody: { review_id: string; error: string; attempt_count: number }[] = [];

    for (const j of picked) {
      const body = bodyMap.get(j.review_id);
      if (!body || body.trim().length === 0) {
        toFailMissingBody.push({
          review_id: j.review_id,
          attempt_count: j.attempt_count,
          error: 'missing body_main in course_review_bodies',
        });
        continue;
      }

      const h = sha256Hex(body);
      const existing = hashMap.get(j.review_id) ?? null;

      if (existing && existing === h) {
        toDoneSkip.push(j.review_id);
        continue;
      }

      need.push({ review_id: j.review_id, body, hash: h, attempt_count: j.attempt_count });
    }

    // 7) スキップ分は job を done に
    let skipped = 0;
    if (toDoneSkip.length > 0) {
      const nowIso = new Date().toISOString();
      const { error: doneErr } = await supabaseAdmin
        .from('embedding_jobs')
        .update({
          status: 'done',
          last_error: null,
          locked_at: null,
          locked_by: runner,
          updated_at: nowIso,
        })
        .in('review_id', toDoneSkip);

      if (doneErr) {
        return NextResponse.json(
          { ok: false, error: 'failed to mark skipped jobs as done', details: supabaseErrorToJson(doneErr) },
          { status: 500 }
        );
      }
      skipped = toDoneSkip.length;
    }

    // 8) 本文欠損は failed
    let failed = 0;
    if (toFailMissingBody.length > 0) {
      const nowIso = new Date().toISOString();
      const rows = toFailMissingBody.map((x) => ({
        review_id: x.review_id,
        status: 'failed',
        attempt_count: x.attempt_count + 1,
        last_error: x.error,
        locked_at: null,
        locked_by: runner,
        updated_at: nowIso,
      }));

      const { error: failErr } = await supabaseAdmin
        .from('embedding_jobs')
        .upsert(rows, { onConflict: 'review_id' });

      if (failErr) {
        return NextResponse.json(
          { ok: false, error: 'failed to mark missing-body jobs as failed', details: supabaseErrorToJson(failErr) },
          { status: 500 }
        );
      }
      failed += rows.length;
    }

    // 9) embedding生成（OpenAI）→ embeddings upsert → job done/failed
    let done = 0;

    for (const batch of chunk(need, EMBEDDING_BATCH_SIZE)) {
      const nowIso = new Date().toISOString();

      try {
        // OpenAIへまとめて投げる
        const resp = await openai.embeddings.create({
          model,
          input: batch.map((x) => x.body),
          encoding_format: 'float',
        });

        const vecs = (resp.data || []).map((d: any) => d.embedding);
        if (vecs.length !== batch.length) {
          throw new Error(`embedding response mismatch: got ${vecs.length}, expected ${batch.length}`);
        }

        // embeddingsを upsert（review_id PK）
        const embedRows = batch.map((x, i) => ({
          review_id: x.review_id,
          embedding: vecs[i],
          model,
          content_hash: x.hash,
          updated_at: nowIso,
        }));

        const { error: upErr } = await supabaseAdmin
          .from('course_review_embeddings')
          .upsert(embedRows, { onConflict: 'review_id' });

        if (upErr) throw upErr;

        // job を done に（attempt_countは+1して記録）
        const jobRows = batch.map((x) => ({
          review_id: x.review_id,
          status: 'done',
          attempt_count: x.attempt_count + 1,
          last_error: null,
          locked_at: null,
          locked_by: runner,
          updated_at: nowIso,
        }));

        const { error: jobDoneErr } = await supabaseAdmin
          .from('embedding_jobs')
          .upsert(jobRows, { onConflict: 'review_id' });

        if (jobDoneErr) throw jobDoneErr;

        done += batch.length;
      } catch (e: any) {
        const msg = e?.message ?? 'embedding batch failed';

        // このバッチ分だけ failed にして次へ（全体停止しない）
        const jobFailRows = batch.map((x) => ({
          review_id: x.review_id,
          status: 'failed',
          attempt_count: x.attempt_count + 1,
          last_error: msg,
          locked_at: null,
          locked_by: runner,
          updated_at: nowIso,
        }));

        const { error: jobFailErr } = await supabaseAdmin
          .from('embedding_jobs')
          .upsert(jobFailRows, { onConflict: 'review_id' });

        if (jobFailErr) {
          // ここで死ぬと復旧面倒なので、レスポンスにエラーを返す
          return NextResponse.json(
            { ok: false, error: 'failed to update embedding_jobs to failed', details: supabaseErrorToJson(jobFailErr) },
            { status: 500 }
          );
        }

        failed += batch.length;
      }
    }

    return NextResponse.json({
      ok: true,
      runner,
      elapsed_ms: Date.now() - startedAt,
      counts: {
        picked: picked.length,
        done,
        skipped,
        failed,
      },
    });
  } catch (e: any) {
    console.error('[batch/embeddings/run] fatal:', e);
    return NextResponse.json({ ok: false, error: e?.message ?? 'server error' }, { status: 500 });
  }
}
