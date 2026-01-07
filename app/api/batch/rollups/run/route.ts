export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

/**
 * ---------------------------
 * このエンドポイントの責務
 * ---------------------------
 * - subject_rollups.is_dirty = true の subject を拾う
 * - course_reviews から review_count / avg_* を更新
 * - course_review_bodies から新規レビュー本文を拾って summary_1000 を更新
 * - 成功したら is_dirty=false に戻す（失敗したら維持）
 *
 * embeddingは一切触らない。責務分離。
 */

// 1回の実行で処理する subject 数（最初は小さめ）
const MAX_SUBJECTS_PER_RUN = 5;

// 集計用に読むレビュー上限（将来SQL集計へ寄せるなら要らなくなる）
const MAX_REVIEWS_PER_SUBJECT_FOR_STATS = 5000;

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

function checkBatchAuth(req: Request) {
  const expected = requireEnv('BATCH_TOKEN', process.env.BATCH_TOKEN);
  const got = req.headers.get('x-batch-token') || '';
  return got === expected;
}

function avg(values: number[]) {
  if (values.length === 0) return null;
  const s = values.reduce((a, b) => a + b, 0);
  return s / values.length;
}

function normalizeBodyForSummary(body: string) {
  const t = body.trim().replace(/\s+/g, ' ');
  return t.length <= MAX_BODY_CHARS_FOR_SUMMARY ? t : t.slice(0, MAX_BODY_CHARS_FOR_SUMMARY) + '…';
}

function getOpenAIForSummary() {
  // 分けたい場合：OPENAI_API_KEY_SUMMARY を設定すればそちら優先
  const apiKey =
    process.env.OPENAI_API_KEY_SUMMARY || process.env.OPENAI_API_KEY || '';
  requireEnv('OPENAI_API_KEY(or _SUMMARY)', apiKey);
  return new OpenAI({ apiKey });
}

function getSummaryModel() {
  // 環境に合わせて変えてOK。未指定ならこれ。
  return process.env.OPENAI_SUMMARY_MODEL || 'gpt-5-mini';
}

// -------- 型（必要最低限） --------

type RollupRow = {
  subject_id: string;
  summary_1000: string;
  last_processed_review_id: string | null;
  updated_at: string;
};

type ReviewRow = {
  id: string;
  subject_id: string;
  created_at: string;

  credit_ease: number;
  class_difficulty: number;
  assignment_load: number;
  attendance_strictness: number;
  satisfaction: number;
  recommendation: number;
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
        rollup_updated: false,
        summary_updated: false,
        kept_dirty: false,
        errors: [] as any[],
      };

      try {
        // 2-A) レビューを取る（created_at順）
        const { data: reviews, error: revErr } = await supabaseAdmin
          .from('course_reviews')
          .select(
            'id,subject_id,created_at,credit_ease,class_difficulty,assignment_load,attendance_strictness,satisfaction,recommendation'
          )
          .eq('subject_id', subjectId)
          .order('created_at', { ascending: true })
          .limit(MAX_REVIEWS_PER_SUBJECT_FOR_STATS);

        if (revErr) throw revErr;

        const rows = (reviews || []) as ReviewRow[];

        // レビューが無いのにdirtyになってるケース
        if (rows.length === 0) {
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
              summary_1000: '',
              last_processed_review_id: null,
              is_dirty: false,
              updated_at: new Date().toISOString(),
            })
            .eq('subject_id', subjectId);

          if (updErr) throw updErr;

          rollupsUpdated += 1;
          summariesUpdated += 1;
          result.rollup_updated = true;
          result.summary_updated = true;

          perSubject.push(result);
          continue;
        }

        // 2-B) avg / count を更新（まずはJS集計。将来SQL集計へ寄せる）
        const count = rows.length;

        const stats = {
          review_count: count,
          avg_credit_ease: avg(rows.map((x) => x.credit_ease)),
          avg_class_difficulty: avg(rows.map((x) => x.class_difficulty)),
          avg_assignment_load: avg(rows.map((x) => x.assignment_load)),
          avg_attendance_strictness: avg(rows.map((x) => x.attendance_strictness)),
          avg_satisfaction: avg(rows.map((x) => x.satisfaction)),
          avg_recommendation: avg(rows.map((x) => x.recommendation)),
        };

        {
          const { error: updErr } = await supabaseAdmin
            .from('subject_rollups')
            .update({ ...stats, updated_at: new Date().toISOString() })
            .eq('subject_id', subjectId);

          if (updErr) throw updErr;

          rollupsUpdated += 1;
          result.rollup_updated = true;
        }

        // 2-C) summary 更新の対象レビューIDを決める
        let newIds: string[] = [];

        if (r.last_processed_review_id) {
          const idx = rows.findIndex((x) => x.id === r.last_processed_review_id);
          if (idx >= 0) {
            newIds = rows.slice(idx + 1).map((x) => x.id);
          } else {
            // last_processed が見つからない（移行/削除の可能性）
            // ここは保険として “直近N件” で再要約
            newIds = rows.map((x) => x.id);
          }
        } else {
          // 初回は全件。ただし多すぎるので直近N件へ
          newIds = rows.map((x) => x.id);
        }

        // 最新側から最大件数に制限
        if (newIds.length > MAX_NEW_REVIEWS_FOR_SUMMARY) {
          newIds = newIds.slice(-MAX_NEW_REVIEWS_FOR_SUMMARY);
        }

        // 2-D) 本文を取得
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

        // 2-E) 新規が無ければ summary は更新せずに dirty を落とす
        if (newBodies.length === 0) {
          const latestId = rows[rows.length - 1].id;

          const { error: clearErr } = await supabaseAdmin
            .from('subject_rollups')
            .update({
              // summaryはそのまま
              last_processed_review_id: latestId,
              is_dirty: false,
              updated_at: new Date().toISOString(),
            })
            .eq('subject_id', subjectId);

          if (clearErr) throw clearErr;

          result.summary_updated = false; // 更新してないのでfalse
          perSubject.push(result);
          continue;
        }

        // 2-F) OpenAIで summary を統合更新
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
        const latestId = rows[rows.length - 1].id;

        // 2-G) summary を保存し、dirty を落とす
        {
          const { error: sumUpdErr } = await supabaseAdmin
            .from('subject_rollups')
            .update({
              summary_1000: newSummary,
              last_processed_review_id: latestId,
              is_dirty: false,
              updated_at: new Date().toISOString(),
            })
            .eq('subject_id', subjectId);

          if (sumUpdErr) throw sumUpdErr;

          summariesUpdated += 1;
          result.summary_updated = true;
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
