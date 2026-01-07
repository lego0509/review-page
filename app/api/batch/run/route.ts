// app/api/batch/run/route.ts
//
// 目的:
// - course_reviews 投稿後に立てた subject_rollups.is_dirty を起点に、定期バッチで
//   1) まだembeddingが無い/古いレビューを embedding 生成して course_review_embeddings を更新
//   2) subject_rollups の count/avg を更新
//   3) subject_rollups.summary_1000 を更新（差分 or 最小限の再要約）
//   4) 成功したsubjectは is_dirty=false に戻す
//
// 前提:
// - このAPIは GitHub Actions など “サーバ側” から叩く（フロントから叩かない）
// - 認証用に BATCH_TOKEN を必須にする（漏れたらOpenAI課金事故）
// - Supabaseは service_role で叩く（supabaseAdmin）
//
// 必要な環境変数（Vercel側）:
// - BATCH_TOKEN: このAPIを叩くための秘密トークン（Actions側Secretsと一致）
// - OPENAI_API_KEY: OpenAI APIキー
// - OPENAI_EMBEDDING_MODEL: 省略可（default: text-embedding-3-small）
// - OPENAI_SUMMARY_MODEL: 省略可（default: gpt-5-mini 相当を想定、なければ適当に変える）
//
// 注意:
// - “編集機能なし” 方針なので、本文更新は基本起きない想定。
//   ただし将来データ修正/移行で本文が変わった場合に備え content_hash で再embeddingできるようにしてる。

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import OpenAI from 'openai';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

// ---------- 設定（必要なら増やす） ----------

// 1回のバッチで処理する subject 数（多すぎるとVercelの実行時間で死ぬ）
const MAX_SUBJECTS_PER_RUN = 5;

// 1 subject あたり、embedding対象として見に行く review 数（まずは安全寄り）
const MAX_REVIEWS_PER_SUBJECT_FOR_EMBED = 200;

// rollup集計のために取る review 数（本当はSQL集計が正しいけど、まずはJS集計で動かす）
const MAX_REVIEWS_PER_SUBJECT_FOR_STATS = 5000;

// summary更新のために取り込む “新規レビュー” の最大件数（トークン爆発防止）
const MAX_NEW_REVIEWS_FOR_SUMMARY = 30;

// embeddingをまとめて投げるバッチサイズ（API呼び出し回数削減）
const EMBEDDING_BATCH_SIZE = 16;

// 1本文あたり summary 用に使う最大文字数（長文爆発防止）
const MAX_BODY_CHARS_FOR_SUMMARY = 1200;

// ---------- 型（DBスキーマに合わせる） ----------

type SubjectRollupRow = {
  subject_id: string;
  is_dirty: boolean;
  summary_1000: string;
  last_processed_review_id: string | null;
  updated_at: string;
};

type CourseReviewRowForStats = {
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

type ReviewBodyRow = {
  review_id: string;
  body_main: string;
};

type EmbeddingMetaRow = {
  review_id: string;
  content_hash: string | null;
};

// ---------- 小物ユーティリティ ----------

function supabaseErrorToJson(err: any) {
  if (!err) return null;
  return { message: err.message, code: err.code, details: err.details, hint: err.hint };
}

// SHA256 hex(64) を作る（DBのcontent_hash用）
function sha256Hex(text: string) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// 配列を chunk に分割（PostgRESTのin()やレスポンスサイズに優しくする）
function chunk<T>(arr: T[], size: number) {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// 平均（0件なら null）
function avg(values: number[]) {
  if (values.length === 0) return null;
  const s = values.reduce((a, b) => a + b, 0);
  return s / values.length;
}

// summary用に本文を短く整形
function normalizeBodyForSummary(body: string) {
  const t = body.trim().replace(/\s+/g, ' ');
  return t.length <= MAX_BODY_CHARS_FOR_SUMMARY ? t : t.slice(0, MAX_BODY_CHARS_FOR_SUMMARY) + '…';
}

// ---------- OpenAI クライアント ----------

function getOpenAIClient() {
  // OpenAI SDKは OPENAI_API_KEY を環境変数から読む
  return new OpenAI();
}

function getEmbeddingModel() {
  return process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
}

function getSummaryModel() {
  // gpt-5系が無い環境なら、ここを gpt-4.1-mini など手元の利用可能モデルに変えてOK
  return process.env.OPENAI_SUMMARY_MODEL || 'gpt-5-mini';
}

// ---------- 認証 ----------

function checkBatchAuth(req: Request) {
  const expected = process.env.BATCH_TOKEN;
  if (!expected) {
    // ここが未設定のまま本番に出すのは危険なので、明示的に落とす
    throw new Error('BATCH_TOKEN is not set');
  }

  // Actions側から: curl -H "X-Batch-Token: $TOKEN"
  const got = req.headers.get('x-batch-token') || '';
  return got === expected;
}

// ---------- メイン処理 ----------

export async function POST(req: Request) {
  const startedAt = Date.now();
  const runner =
    req.headers.get('x-batch-runner') || process.env.VERCEL_GIT_COMMIT_SHA || 'unknown-runner';

  try {
    // --- 認証 ---
    if (!checkBatchAuth(req)) {
      return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
    }

    // --- OpenAIクライアント ---
    const openai = getOpenAIClient();
    const embeddingModel = getEmbeddingModel();
    const summaryModel = getSummaryModel();

    // --- 1) dirty subject を拾う ---
    const { data: dirtySubjects, error: dirtyErr } = await supabaseAdmin
      .from('subject_rollups')
      .select('subject_id,is_dirty,summary_1000,last_processed_review_id,updated_at')
      .eq('is_dirty', true)
      .order('updated_at', { ascending: true })
      .limit(MAX_SUBJECTS_PER_RUN);

    if (dirtyErr) {
      return NextResponse.json(
        { ok: false, error: 'failed to fetch dirty subjects', details: supabaseErrorToJson(dirtyErr) },
        { status: 500 }
      );
    }

    if (!dirtySubjects || dirtySubjects.length === 0) {
      return NextResponse.json({
        ok: true,
        message: 'no dirty subjects',
        runner,
        elapsed_ms: Date.now() - startedAt,
        counts: { subjects: 0, embeddings_done: 0, embeddings_failed: 0, rollups_updated: 0, summaries_updated: 0 },
      });
    }

    // 集計用カウンタ
    let embeddingsDone = 0;
    let embeddingsFailed = 0;
    let rollupsUpdated = 0;
    let summariesUpdated = 0;

    // subjectごとの結果（Actionsログで見やすくする）
    const subjectResults: any[] = [];

    // --- 2) subjectごとに処理 ---
    for (const rollup of dirtySubjects as SubjectRollupRow[]) {
      const subjectId = rollup.subject_id;

      const subjectResult: any = {
        subject_id: subjectId,
        ok: true,
        embedding: { done: 0, failed: 0, skipped: 0 },
        rollup_updated: false,
        summary_updated: false,
        kept_dirty: false,
        errors: [] as any[],
      };

      try {
        // ---------- A) reviews を取得（embedding用・stats用） ----------
        // stats用に全件寄りで取る（上限あり）
        const { data: reviews, error: reviewsErr } = await supabaseAdmin
          .from('course_reviews')
          .select(
            'id,subject_id,created_at,credit_ease,class_difficulty,assignment_load,attendance_strictness,satisfaction,recommendation'
          )
          .eq('subject_id', subjectId)
          .order('created_at', { ascending: true })
          .limit(MAX_REVIEWS_PER_SUBJECT_FOR_STATS);

        if (reviewsErr) throw reviewsErr;

        const reviewRows = (reviews || []) as CourseReviewRowForStats[];

        if (reviewRows.length === 0) {
          // 対象subjectにレビューが無いのにdirtyになってるケース（バグ/削除/移行）
          // とりあえず rollups を空で更新して dirty を落とす
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
              is_dirty: false,
            })
            .eq('subject_id', subjectId);

          if (updErr) throw updErr;

          subjectResult.rollup_updated = true;
          rollupsUpdated += 1;

          subjectResults.push(subjectResult);
          continue;
        }

        // embedding対象として見るreview数（statsより少なめにして安全運用）
        const reviewsForEmbed = reviewRows.slice(
          Math.max(0, reviewRows.length - MAX_REVIEWS_PER_SUBJECT_FOR_EMBED)
        );

        const reviewIdsForEmbed = reviewsForEmbed.map((r) => r.id);

        // ---------- B) bodies を取得 ----------
        // review_id -> body_main を作る
        const bodyMap = new Map<string, string>();

        for (const idChunk of chunk(reviewIdsForEmbed, 200)) {
          const { data: bodies, error: bodiesErr } = await supabaseAdmin
            .from('course_review_bodies')
            .select('review_id,body_main')
            .in('review_id', idChunk);

          if (bodiesErr) throw bodiesErr;

          for (const b of (bodies || []) as ReviewBodyRow[]) {
            bodyMap.set(b.review_id, b.body_main);
          }
        }

        // ---------- C) embeddings の現状を取得（content_hash比較用） ----------
        const embedMetaMap = new Map<string, string | null>();

        for (const idChunk of chunk(reviewIdsForEmbed, 200)) {
          const { data: metas, error: metasErr } = await supabaseAdmin
            .from('course_review_embeddings')
            .select('review_id,content_hash')
            .in('review_id', idChunk);

          if (metasErr) throw metasErr;

          for (const m of (metas || []) as EmbeddingMetaRow[]) {
            embedMetaMap.set(m.review_id, m.content_hash ?? null);
          }
        }

        // ---------- D) embeddingが必要なレビューを抽出 ----------
        const needEmbed: { review_id: string; body: string; hash: string }[] = [];

        for (const r of reviewsForEmbed) {
          const body = bodyMap.get(r.id);
          if (!body) {
            // 本来は必ずある想定。無いならデータ不整合なので次回もdirtyにして再試行させる
            subjectResult.embedding.skipped += 1;
            subjectResult.errors.push({ type: 'missing_body', review_id: r.id });
            continue;
          }

          const hash = sha256Hex(body);
          const existingHash = embedMetaMap.get(r.id) ?? null;

          // embeddingが無い or 本文が変わった（hash違い）なら再生成
          if (!existingHash || existingHash !== hash) {
            needEmbed.push({ review_id: r.id, body, hash });
          } else {
            subjectResult.embedding.skipped += 1;
          }
        }

        // ---------- E) embedding生成（OpenAI） ----------
        // ここは “まとめて投げる” ことで呼び出し回数を削る
        for (const batch of chunk(needEmbed, EMBEDDING_BATCH_SIZE)) {
          // job: processing にする（デバッグ用。厳密ロックまではやらない）
          {
            const nowIso = new Date().toISOString();
            const upsertRows = batch.map((x) => ({
              review_id: x.review_id,
              status: 'processing',
              locked_at: nowIso,
              locked_by: runner,
              // attempt_count は update で増やすのが理想だが、
              // postgrestだけでやると面倒なので “まず動く” を優先
            }));

            const { error: jobErr } = await supabaseAdmin
              .from('embedding_jobs')
              .upsert(upsertRows, { onConflict: 'review_id' });

            if (jobErr) {
              // jobテーブルは補助なので、ここで全体停止はしない（ただしログに残す）
              subjectResult.errors.push({ type: 'embedding_jobs_upsert_failed', details: supabaseErrorToJson(jobErr) });
            }
          }

          // OpenAI embeddings API 呼び出し
          let embeddingResp: any;
          try {
            embeddingResp = await openai.embeddings.create({
              model: embeddingModel,
              input: batch.map((x) => x.body),
              encoding_format: 'float',
            });
          } catch (e: any) {
            // バッチ単位で失敗した場合: このbatchのreview全て failed 扱いにして次へ
            const msg = e?.message ?? 'openai embeddings error';

            embeddingsFailed += batch.length;
            subjectResult.embedding.failed += batch.length;

            const { error: jobFailErr } = await supabaseAdmin
              .from('embedding_jobs')
              .upsert(
                batch.map((x) => ({
                  review_id: x.review_id,
                  status: 'failed',
                  last_error: msg,
                  locked_at: null,
                  locked_by: runner,
                })),
                { onConflict: 'review_id' }
              );

            if (jobFailErr) {
              subjectResult.errors.push({ type: 'embedding_jobs_fail_update_failed', details: supabaseErrorToJson(jobFailErr) });
            }

            subjectResult.errors.push({ type: 'openai_embeddings_failed', message: msg });
            continue;
          }

          // 返ってきた embedding をDBへ upsert
          try {
            const vectors = (embeddingResp?.data || []).map((d: any) => d.embedding);
            if (vectors.length !== batch.length) {
              throw new Error(`embedding response mismatch: got ${vectors.length}, expected ${batch.length}`);
            }

            const rows = batch.map((x, i) => ({
              review_id: x.review_id,
              embedding: vectors[i],
              model: embeddingModel,
              content_hash: x.hash,
              updated_at: new Date().toISOString(),
            }));

            const { error: upErr } = await supabaseAdmin
              .from('course_review_embeddings')
              .upsert(rows, { onConflict: 'review_id' });

            if (upErr) throw upErr;

            // job: done にする
            const { error: jobDoneErr } = await supabaseAdmin
              .from('embedding_jobs')
              .upsert(
                batch.map((x) => ({
                  review_id: x.review_id,
                  status: 'done',
                  last_error: null,
                  locked_at: null,
                  locked_by: runner,
                })),
                { onConflict: 'review_id' }
              );

            if (jobDoneErr) {
              subjectResult.errors.push({ type: 'embedding_jobs_done_update_failed', details: supabaseErrorToJson(jobDoneErr) });
            }

            embeddingsDone += batch.length;
            subjectResult.embedding.done += batch.length;
          } catch (e: any) {
            const msg = e?.message ?? 'failed to upsert embeddings';

            embeddingsFailed += batch.length;
            subjectResult.embedding.failed += batch.length;

            const { error: jobFailErr } = await supabaseAdmin
              .from('embedding_jobs')
              .upsert(
                batch.map((x) => ({
                  review_id: x.review_id,
                  status: 'failed',
                  last_error: msg,
                  locked_at: null,
                  locked_by: runner,
                })),
                { onConflict: 'review_id' }
              );

            if (jobFailErr) {
              subjectResult.errors.push({ type: 'embedding_jobs_fail_update_failed', details: supabaseErrorToJson(jobFailErr) });
            }

            subjectResult.errors.push({ type: 'embedding_upsert_failed', message: msg });
          }
        }

        // ---------- F) rollups（count/avg）更新 ----------
        {
          const count = reviewRows.length;

          const avgCreditEase = avg(reviewRows.map((r) => r.credit_ease));
          const avgClassDifficulty = avg(reviewRows.map((r) => r.class_difficulty));
          const avgAssignmentLoad = avg(reviewRows.map((r) => r.assignment_load));
          const avgAttendanceStrictness = avg(reviewRows.map((r) => r.attendance_strictness));
          const avgSatisfaction = avg(reviewRows.map((r) => r.satisfaction));
          const avgRecommendation = avg(reviewRows.map((r) => r.recommendation));

          const { error: updErr } = await supabaseAdmin
            .from('subject_rollups')
            .update({
              review_count: count,
              avg_credit_ease: avgCreditEase,
              avg_class_difficulty: avgClassDifficulty,
              avg_assignment_load: avgAssignmentLoad,
              avg_attendance_strictness: avgAttendanceStrictness,
              avg_satisfaction: avgSatisfaction,
              avg_recommendation: avgRecommendation,
              updated_at: new Date().toISOString(),
            })
            .eq('subject_id', subjectId);

          if (updErr) throw updErr;

          subjectResult.rollup_updated = true;
          rollupsUpdated += 1;
        }

        // ---------- G) summary_1000 更新 ----------
        // “差分更新”っぽく見せるため last_processed_review_id を使う。
        // ただし、厳密に “ID順” は保証できないので created_at の並びで扱う。
        let newReviewIdsForSummary: string[] = [];

        if (rollup.last_processed_review_id) {
          const idx = reviewRows.findIndex((r) => r.id === rollup.last_processed_review_id);
          if (idx >= 0) {
            newReviewIdsForSummary = reviewRows.slice(idx + 1).map((r) => r.id);
          } else {
            // last_processed_review_id が見つからない（古いデータ/移行）
            // この場合は保険として “直近N件” をまとめて再要約
            newReviewIdsForSummary = reviewRows.map((r) => r.id);
          }
        } else {
          // 初回は全件から。ただし多すぎると死ぬので後ろN件に絞る
          newReviewIdsForSummary = reviewRows.map((r) => r.id);
        }

        // 要約に使う件数を制限（最新のレビューからMAX件）
        if (newReviewIdsForSummary.length > MAX_NEW_REVIEWS_FOR_SUMMARY) {
          newReviewIdsForSummary = newReviewIdsForSummary.slice(-MAX_NEW_REVIEWS_FOR_SUMMARY);
        }

        // 本文が取れないものは落とす
        const newBodies: string[] = [];
        for (const rid of newReviewIdsForSummary) {
          // embedding用に取った map は “最近のレビュー” だけなので、summary対象が古い場合は不足する。
          // ここでは不足分があり得るので、足りなければDBから追加で取る。
          let body = bodyMap.get(rid);

          if (!body) {
            const { data: one, error: oneErr } = await supabaseAdmin
              .from('course_review_bodies')
              .select('review_id,body_main')
              .eq('review_id', rid)
              .maybeSingle();

            if (oneErr) throw oneErr;
            body = (one as any)?.body_main;
          }

          if (body && body.trim().length > 0) newBodies.push(normalizeBodyForSummary(body));
        }

        // 本文が取れた場合だけ要約更新
        if (newBodies.length > 0) {
          // Responses API で要約
          const prevSummary = (rollup.summary_1000 || '').trim();

          const prompt = {
            previous_summary: prevSummary,
            new_reviews: newBodies,
            rules: [
              '日本語で書く',
              '1000文字以内（できれば800文字以内）',
              '偏りが出ないように、良い点/悪い点/注意点/おすすめ対象をバランスよく',
              '固有名詞や個人名（教員名）は可能なら伏せる（入力されていても）',
              '箇条書きOK。ただし読みやすさ優先で。',
            ],
          };

          const resp = await openai.responses.create({
            model: summaryModel,
            input: [
              {
                role: 'developer',
                content:
                  'あなたは大学授業レビューの要約担当です。与えられた過去要約と新規レビュー本文から、最新の統合要約を作ってください。',
              },
              {
                role: 'user',
                content: JSON.stringify(prompt),
              },
            ],
          });

          const newSummary = (resp.output_text || '').trim();

          // 更新対象の last_processed_review_id は “レビューの最新id” に寄せる（created_at順の最後）
          const latestReviewId = reviewRows[reviewRows.length - 1].id;

          const { error: sumUpdErr } = await supabaseAdmin
            .from('subject_rollups')
            .update({
              summary_1000: newSummary,
              last_processed_review_id: latestReviewId,
              updated_at: new Date().toISOString(),
            })
            .eq('subject_id', subjectId);

          if (sumUpdErr) throw sumUpdErr;

          subjectResult.summary_updated = true;
          summariesUpdated += 1;
        }

        // ---------- H) dirty を落とすか判断 ----------
        // このsubjectで embedding 失敗や本文欠損があれば次回リトライしたいので dirty を維持
        const hasProblems =
          subjectResult.embedding.failed > 0 ||
          subjectResult.errors.some((e: any) => e?.type === 'missing_body');

        if (hasProblems) {
          subjectResult.kept_dirty = true;
          // 明示的に is_dirty=true にしておく（他更新でfalseに戻る事故防止）
          const { error: keepErr } = await supabaseAdmin
            .from('subject_rollups')
            .update({ is_dirty: true, updated_at: new Date().toISOString() })
            .eq('subject_id', subjectId);

          if (keepErr) {
            subjectResult.errors.push({ type: 'keep_dirty_update_failed', details: supabaseErrorToJson(keepErr) });
          }
        } else {
          const { error: clearErr } = await supabaseAdmin
            .from('subject_rollups')
            .update({ is_dirty: false, updated_at: new Date().toISOString() })
            .eq('subject_id', subjectId);

          if (clearErr) throw clearErr;
        }

        subjectResults.push(subjectResult);
      } catch (e: any) {
        // subject単位の致命エラー。次回に回したいので dirty は落とさない。
        subjectResult.ok = false;
        subjectResult.kept_dirty = true;
        subjectResult.errors.push({ type: 'subject_failed', message: e?.message ?? String(e) });

        // is_dirty を維持（落ちている可能性を考えて明示的にtrue）
        const { error: keepErr } = await supabaseAdmin
          .from('subject_rollups')
          .update({ is_dirty: true, updated_at: new Date().toISOString() })
          .eq('subject_id', subjectId);

        if (keepErr) {
          subjectResult.errors.push({ type: 'keep_dirty_update_failed', details: supabaseErrorToJson(keepErr) });
        }

        subjectResults.push(subjectResult);
      }
    }

    // --- レスポンス（Actionsログに残す用） ---
    return NextResponse.json({
      ok: true,
      runner,
      elapsed_ms: Date.now() - startedAt,
      processed_subjects: dirtySubjects.length,
      counts: {
        subjects: dirtySubjects.length,
        embeddings_done: embeddingsDone,
        embeddings_failed: embeddingsFailed,
        rollups_updated: rollupsUpdated,
        summaries_updated: summariesUpdated,
      },
      subjects: subjectResults,
    });
  } catch (e: any) {
    // API全体の致命エラー（認証設定ミスなど）
    console.error('[batch/run] fatal:', e);
    return NextResponse.json(
      { ok: false, error: e?.message ?? 'server error' },
      { status: 500 }
    );
  }
}
