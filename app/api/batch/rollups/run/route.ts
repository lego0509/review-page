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
  s
