export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

/**
 * ---------------------------
 * このエンドポイントの責務（完成版）
 * ---------------------------
 * - subject_rollups.is_dirty = true の subject を拾う
 *
 * - stats（review_count / avg_* / performance_selfカウント）は
 *   DB側集計（RPC: subject_review_stats）で正確に更新する
 *   → アプリ側でcourse_reviews全件を吸い上げない
 *
 * - summary_1000 は差分方式：
 *   last_processed_review_id の created_at を起点に
 *   それ以降に追加されたレビュー本文（course_review_bodies）だけを要約に反映する
 *
 * - 新規レビューが多すぎる場合は is_dirty=true のままにして次回へ回す
 * - 成功して追いついたら is_dirty=false に戻す
 *
 * embeddingは一切触らない（責務分離）
 */

// 1回の実行で処理する subject 数（最初は小さめ）
const MAX_SUBJECTS_PER_RUN = 5;

// 要約に使う “新規レビュー” の最大件数（トークン爆発防止）
const MAX_NEW_REVIEWS_FOR_SUMMARY = 30;

// 1本文あたり要約に渡す最大文字数（長文爆発防止）
const MAX_BODY_CHARS_FOR_SUMMARY = 1200;

// -------- util --------

function supabaseErrorToJson(err: any) {
  if (!err) return null;
  return { message: err.message, code: err.code, details: err.details, hint: err.hint };
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

/**
 * 外部から叩けるURLにする以上、最低限の鍵が必要。
 * これ無しだと「誰でも実行→課金事故」になる。
 */
function checkBatchAuth(req: Request) {
  const expected = requireEnv('BATCH_TOKEN', process.env.BATCH_TOKEN);
  const got = req.headers.get('x-batch-token') || '';
  return got === expected;
}

function normalizeBodyForSummary(body: string) {
  const t = body.trim().replace(/\s+/g, ' ');
  return t.length <= MAX_BODY_CHARS_FOR_SUMMARY ? t : t.slice(0, MAX_BODY_CHARS_FOR_SUMMARY) + '…';
}

function getOpenAIForSummary() {
  // 分けたい場合：OPENAI_API_KEY_SUMMARY を設定すればそちら優先
  const apiKey = process.env.OPENAI_API_KEY_SUMMARY || process.env.OPENAI_API_KEY || '';
  requireEnv('OPENAI_API_KEY(or _SUMMARY)', apiKey);
  return new OpenAI({ apiKey });
}

function getSummaryModel() {
  // 未指定ならこれ（コスパは別途あなたの判断でOK）
  return process.env.OPENAI_SUMMARY_MODEL || 'gpt-5-mini';
}

// -------- 型（必要最低限） --------

type RollupRow = {
  subject_id: string;
  summary_1000: string;
  last_processed_review_id: string | null;
  updated_at: string;
};

type StatsRow = {
  review_count: number;

  avg_credit_ease: number | null;
  avg_class_difficulty: number | null;
  avg_assignment_load: number | null;
  avg_attendance_strictness: number | null;
  avg_satisfaction: number | null;
  avg_recommendation: number | null;

  // ★追加：performance_selfの集計（1..4）
  count_performance_unknown: number; // performance_self=1
  count_no_credit: number;           // =2
  count_credit_normal: number;       // =3
  count_credit_high: number;         // =4

  latest_review_id: string | null;
  latest_created_at: string | null;
};

type ReviewIdRow = {
  id: string;
  created_at: string;
};

type BodyRow = {
  review_id: string;
  body_main: string;
};

// -------- main --------

export async function POST(req: Request) {
  const startedAt = Date.now();
  const runner =
    req.headers.get('x-batch-runner') ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    'unknown-runner';

  try {
    if (!checkBatchAuth(req)) {
      return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
    }

    const openai = getOpenAIForSummary();
    const model = getSummaryModel();

    // 1) dirty subject を拾う（古い順に処理）
    const { data: dirty, error: dirtyErr } = await supabaseAdmin
      .from('subject_rollups')
      .select('subject_id,summary_1000,last_processed_review_id,updated_at')
      .eq('is_dirty', true)
      .order('updated_at', { ascending: true })
      .limit(MAX_SUBJECTS_PER_RUN);

    if (dirtyErr) {
      return NextResponse.json(
        { ok: false, error: 'failed to fetch dirty subjects', details: supabaseErrorToJson(dirtyErr) },
        { status: 500 }
      );
    }

    const subjects = (dirty || []) as RollupRow[];

    if (subjects.length === 0) {
      return NextResponse.json({
        ok: true,
        message: 'no dirty subjects',
        runner,
        elapsed_ms: Date.now() - startedAt,
        counts: { subjects: 0, rollups_updated: 0, summaries_updated: 0, kept_dirty: 0 },
      });
    }

    let rollupsUpdated = 0;
    let summariesUpdated = 0;
    let keptDirty = 0;

    const perSubject: any[] = [];

    // 2) subjectごとに処理
    for (const r of subjects) {
      const subjectId = r.subject_id;

      const result: any = {
        subject_id: subjectId,
        ok: true,
        stats_updated: false,
        summary_updated: false,
        kept_dirty: false,
        errors: [] as any[],
      };

      try {
        // -------------------------
        // 2-A) statsをDB側で集計（RPC）
        // -------------------------
        // ※ ここで course_reviews 全件をアプリに持ってこない
        const { data: statsData, error: statsErr } = await supabaseAdmin
          .rpc('subject_review_stats', { p_subject_id: subjectId })
          .single();

        if (statsErr) throw statsErr;

        const stats = statsData as StatsRow;

        // レビュー0件なのにdirtyになってる保険ケース
        // ここでrollupsを「空」にしてdirtyを落とす
        if (!stats.latest_review_id || stats.review_count === 0) {
          const { error: updErr } = await supabaseAdmin
            .from('subject_rollups')
            .update({
              review_count: 0,
              avg_credit_ease: null,
              avg_class_difficulty: null,
              avg_assignment_load: null,
              avg_attendance_strictness: null,
              avg_satisfaction: null,
              avg_recommendation: null,

              // ★追加カラムもゼロに
              count_performance_unknown: 0,
              count_no_credit: 0,
              count_credit_normal: 0,
              count_credit_high: 0,

              summary_1000: '',
              last_processed_review_id: null,
              is_dirty: false,
              updated_at: new Date().toISOString(),
            })
            .eq('subject_id', subjectId);

          if (updErr) throw updErr;

          rollupsUpdated += 1;
          summariesUpdated += 1;
          result.stats_updated = true;
          result.summary_updated = true;
          perSubject.push(result);
          continue;
        }

        // statsをsubject_rollupsへ反映
        {
          const { error: updErr } = await supabaseAdmin
            .from('subject_rollups')
            .update({
              review_count: stats.review_count,
              avg_credit_ease: stats.avg_credit_ease,
              avg_class_difficulty: stats.avg_class_difficulty,
              avg_assignment_load: stats.avg_assignment_load,
              avg_attendance_strictness: stats.avg_attendance_strictness,
              avg_satisfaction: stats.avg_satisfaction,
              avg_recommendation: stats.avg_recommendation,

              // ★追加：単位取得状況（performance_selfの集計）
              count_performance_unknown: stats.count_performance_unknown,
              count_no_credit: stats.count_no_credit,
              count_credit_normal: stats.count_credit_normal,
              count_credit_high: stats.count_credit_high,

              updated_at: new Date().toISOString(),
            })
            .eq('subject_id', subjectId);

          if (updErr) throw updErr;

          rollupsUpdated += 1;
          result.stats_updated = true;
        }

        // -------------------------------------------------------
        // 2-B) summary差分の起点（last_processed_review_idのcreated_at）
        // -------------------------------------------------------
        // UUIDは順序保証が弱いので、「created_at」を基準に差分を取る
        let sinceTime: string | null = null;

        if (r.last_processed_review_id) {
          const { data: base, error: baseErr } = await supabaseAdmin
            .from('course_reviews')
            .select('created_at')
            .eq('id', r.last_processed_review_id)
            .maybeSingle();

          if (baseErr) throw baseErr;

          // 見つからない場合（移行/削除など）→ 初回扱い（sinceTimeなし）
          sinceTime = (base as any)?.created_at ?? null;
        }

        // -------------------------------------------------------
        // 2-C) 新規レビューIDを “created_at基準” で拾う
        // -------------------------------------------------------
        // - sinceTimeあり：created_at >= sinceTime のものを取る（同時刻取りこぼし保険）
        //                 ただし last_processed 自体は除外
        // - sinceTimeなし：初回扱い（古い順に取り込み）
        //
        // +1件余分に取って「まだ残りがあるか」判定し、残りがあればdirty維持
        let q = supabaseAdmin
          .from('course_reviews')
          .select('id,created_at')
          .eq('subject_id', subjectId)
          .order('created_at', { ascending: true });

        if (sinceTime) {
          q = q.gte('created_at', sinceTime);
          if (r.last_processed_review_id) q = q.neq('id', r.last_processed_review_id);
        }

        const { data: newReviewRows, error: newRevErr } = await q.limit(MAX_NEW_REVIEWS_FOR_SUMMARY + 1);

        if (newRevErr) throw newRevErr;

        const newRows = (newReviewRows || []) as ReviewIdRow[];

        // 新規が無い → summaryは触らずにdirtyを落として終わり
        if (newRows.length === 0) {
          const { error: clearErr } = await supabaseAdmin
            .from('subject_rollups')
            .update({
              last_processed_review_id: stats.latest_review_id,
              is_dirty: false,
              updated_at: new Date().toISOString(),
            })
            .eq('subject_id', subjectId);

          if (clearErr) throw clearErr;

          perSubject.push(result);
          continue;
        }

        // まだ残りがあるか（+1件分）
        const hasMore = newRows.length > MAX_NEW_REVIEWS_FOR_SUMMARY;
        const rowsToUse = hasMore ? newRows.slice(0, MAX_NEW_REVIEWS_FOR_SUMMARY) : newRows;

        const newIds = rowsToUse.map((x) => x.id);

        // -------------------------------------------------------
        // 2-D) bodiesをまとめて取得
        // -------------------------------------------------------
        const bodyMap = new Map<string, string>();

        for (const ids of chunk(newIds, 200)) {
          const { data: bodies, error: bErr } = await supabaseAdmin
            .from('course_review_bodies')
            .select('review_id,body_main')
            .in('review_id', ids);

          if (bErr) throw bErr;

          for (const b of (bodies || []) as BodyRow[]) {
            bodyMap.set(b.review_id, b.body_main);
          }
        }

        const newBodies = newIds
          .map((id) => bodyMap.get(id))
          .filter((x): x is string => !!x && x.trim().length > 0)
          .map(normalizeBodyForSummary);

        // bodiesが取れない＝データ不整合
        // 次回再試行できるようdirty維持（処理失敗扱い）
        if (newBodies.length === 0) {
          result.ok = false;
          result.kept_dirty = true;
          result.errors.push({ type: 'missing_bodies', review_ids: newIds });

          keptDirty += 1;

          const { error: keepErr } = await supabaseAdmin
            .from('subject_rollups')
            .update({ is_dirty: true, updated_at: new Date().toISOString() })
            .eq('subject_id', subjectId);

          if (keepErr) {
            result.errors.push({ type: 'keep_dirty_update_failed', details: supabaseErrorToJson(keepErr) });
          }

          perSubject.push(result);
          continue;
        }

        // -------------------------------------------------------
        // 2-E) OpenAIで summary を統合更新（差分追加）
        // -------------------------------------------------------
        const prev = (r.summary_1000 || '').trim();

        const prompt = {
          previous_summary: prev,
          new_reviews: newBodies,
          rules: [
            '日本語で書く',
            '1000文字以内（できれば800文字以内）',
            '良い点/悪い点/注意点/おすすめ対象をバランスよく',
            '個人名（教員名など）は可能なら伏せる',
            '箇条書きOK。読みやすさ優先',
          ],
        };

        const resp = await openai.responses.create({
          model,
          input: [
            {
              role: 'developer',
              content:
                'あなたは大学授業レビューの要約担当です。過去要約と新規レビュー本文から最新の統合要約を作成してください。',
            },
            { role: 'user', content: JSON.stringify(prompt) },
          ],
        });

        const newSummary = (resp.output_text || '').trim();

        // 今回要約に取り込んだ最後のレビューID（ここまで進んだ印）
        const lastProcessedThisRun = rowsToUse[rowsToUse.length - 1].id;

        // -------------------------------------------------------
        // 2-F) summary保存 + dirtyの扱い
        // -------------------------------------------------------
        // - hasMore=true ならまだ未処理が残ってる → dirty維持
        // - hasMore=false なら追いついた → dirty=false
        {
          const { error: sumUpdErr } = await supabaseAdmin
            .from('subject_rollups')
            .update({
              summary_1000: newSummary,
              last_processed_review_id: lastProcessedThisRun,
              is_dirty: hasMore ? true : false,
              updated_at: new Date().toISOString(),
            })
            .eq('subject_id', subjectId);

          if (sumUpdErr) throw sumUpdErr;

          summariesUpdated += 1;
          result.summary_updated = true;

          if (hasMore) {
            result.kept_dirty = true;
            keptDirty += 1;
          }
        }

        perSubject.push(result);
      } catch (e: any) {
        // subject単位で失敗したら dirty を維持して次回リトライ
        result.ok = false;
        result.kept_dirty = true;
        result.errors.push({ message: e?.message ?? String(e) });

        keptDirty += 1;

        // 明示的に dirty を維持（念のため）
        const { error: keepErr } = await supabaseAdmin
          .from('subject_rollups')
          .update({ is_dirty: true, updated_at: new Date().toISOString() })
          .eq('subject_id', subjectId);

        if (keepErr) {
          result.errors.push({ type: 'keep_dirty_update_failed', details: supabaseErrorToJson(keepErr) });
        }

        perSubject.push(result);
      }
    }

    return NextResponse.json({
      ok: true,
      runner,
      elapsed_ms: Date.now() - startedAt,
      counts: {
        subjects: subjects.length,
        rollups_updated: rollupsUpdated,
        summaries_updated: summariesUpdated,
        kept_dirty: keptDirty,
      },
      subjects: perSubject,
    });
  } catch (e: any) {
    console.error('[batch/rollups/run] fatal:', e);
    return NextResponse.json({ ok: false, error: e?.message ?? 'server error' }, { status: 500 });
  }
}
