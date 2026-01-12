export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import { createHmac } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

/**
 * ---------------------------------------
 * /api/ask の責務（会話＋DB参照）
 * ---------------------------------------
 * - ユーザーの自然文質問を受け取る（line_user_id + message）
 * - users.id（内部ID）を確定（line_user_hash で検索/作成）
 * - user_memory（要約）と chat_messages（直近ログ）を読み、会話文脈を作る
 * - OpenAI(Responses API) + tools(Function Calling) で必要なDB検索を実行
 * - 最終回答を返す（聞き返しも含む）
 *
 * 注意:
 * - 「自由なSQL」は絶対やらない（ツールに限定）
 * - 授業DBに無い話題は、普通に一般知識で会話してOK（ただしDB事実はツール結果のみ）
 */

/** ---------- 環境変数 ---------- */
function requireEnv(name: string, value?: string | null) {
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const OPENAI_API_KEY = requireEnv('OPENAI_API_KEY', process.env.OPENAI_API_KEY);
const QA_MODEL = process.env.OPENAI_QA_MODEL || 'gpt-5-mini'; // 雑談/質問両方に使う
const LINE_HASH_PEPPER = requireEnv('LINE_HASH_PEPPER', process.env.LINE_HASH_PEPPER);

/** ---------- OpenAI client ---------- */
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/** ---------- 型（最低限） ---------- */
type AskPayload = {
  line_user_id: string;
  message: string;
};

type UniversityHit = { id: string; name: string };
type SubjectHit = { id: string; name: string; university_id: string };

type RollupRow = {
  subject_id: string;
  summary_1000: string;
  review_count: number;
  avg_credit_ease: number | null;
  avg_class_difficulty: number | null;
  avg_assignment_load: number | null;
  avg_attendance_strictness: number | null;
  avg_satisfaction: number | null;
  avg_recommendation: number | null;
  is_dirty: boolean;
  updated_at: string;
};

type ChatRow = {
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
};

function lineUserIdToHash(lineUserId: string) {
  // LINE userId はDBに生で保存しない（HMACでハッシュ化）
  return createHmac('sha256', LINE_HASH_PEPPER).update(lineUserId, 'utf8').digest('hex');
}

function supabaseErrorToJson(err: any) {
  if (!err) return null;
  return { message: err.message, code: err.code, details: err.details, hint: err.hint };
}

/** LIKE用エスケープ（% と _ を無害化） */
function escapeForLike(s: string) {
  return s.replace(/[%_\\]/g, (m) => '\\' + m);
}

/** ---------- DB: users.id（内部ID）確定 ---------- */
async function getOrCreateUserId(lineUserId: string) {
  const hash = lineUserIdToHash(lineUserId);

  // 既存検索
  const { data: found, error: findErr } = await supabaseAdmin
    .from('users')
    .select('id')
    .eq('line_user_hash', hash)
    .maybeSingle();

  if (findErr) throw findErr;
  if (found?.id) return found.id as string;

  // 無ければ作成（unique競合のリトライ付き）
  const { data: inserted, error: insErr } = await supabaseAdmin
    .from('users')
    .insert({ line_user_hash: hash })
    .select('id')
    .single();

  // 23505: unique_violation（同時作成）
  if (insErr && (insErr as any).code === '23505') {
    const { data: again, error: againErr } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('line_user_hash', hash)
      .single();
    if (againErr) throw againErr;
    if (!again) throw new Error('user conflict retry failed');
    return again.id as string;
  }

  if (insErr) throw insErr;
  return inserted.id as string;
}

/** ---------- DB: user_memory / chat_messages 読み ---------- */
async function getUserMemorySummary(userId: string) {
  // user_memory が無い場合もあり得るので maybeSingle
  const { data, error } = await supabaseAdmin
    .from('user_memory')
    .select('summary_1000')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw error;
  return (data?.summary_1000 ?? '') as string;
}

async function getRecentChatMessages(userId: string, limit = 16) {
  // 新しい順で取って、使うときに古い→新しいに並べ直す
  const { data, error } = await supabaseAdmin
    .from('chat_messages')
    .select('role,content,created_at')
    .eq('user_id', userId)
    .in('role', ['user', 'assistant'])
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;

  return ((data ?? []) as ChatRow[]).reverse();
}

/** ---------- tools（Function Calling）定義 ----------
 * Responses API の function tool は `type/name/parameters` 形式（ネストの function ではない）: :contentReference[oaicite:0]{index=0}
 */
const tools: OpenAI.Responses.Tool[] = [
  {
    type: 'function',
    name: 'get_my_affiliation',
    description: 'ユーザーの登録済み所属（大学/学部/学科）を返す。未登録なら null を返す。',
    strict: true,
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'resolve_university',
    description: '大学名から universities を検索して候補を返す。完全一致があればそれを優先する。',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        university_name: { type: 'string', description: '大学名（ユーザー入力）' },
        limit: { type: 'integer', description: '候補数（1〜10）' },
      },
      required: ['university_name', 'limit'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'search_subjects_by_name',
    description:
      '指定大学の subjects から科目名の部分一致で検索して候補を返す（曖昧なときの候補出し用）。',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        university_id: { type: 'string', description: 'universities.id (uuid)' },
        keyword: { type: 'string', description: '科目名キーワード（部分一致）' },
        limit: { type: 'integer', description: '最大件数（1〜20）' },
      },
      required: ['university_id', 'keyword', 'limit'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'get_subject_rollup',
    description:
      'subject_id を指定して subject_rollups + 科目名 + 大学名を返す。単位取得状況（performance_self）も簡易集計して返す。',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        subject_id: { type: 'string', description: 'subjects.id (uuid)' },
      },
      required: ['subject_id'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'top_subjects_by_metric',
    description:
      '指定大学の subject_rollups から、指標で上位/下位の科目を返す（おすすめ/難しい授業など）。',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        university_id: { type: 'string', description: 'universities.id (uuid)' },
        metric: {
          type: 'string',
          enum: [
            'avg_satisfaction',
            'avg_recommendation',
            'avg_class_difficulty',
            'avg_assignment_load',
            'avg_attendance_strictness',
            'avg_credit_ease',
          ],
        },
        order: { type: 'string', enum: ['asc', 'desc'] },
        limit: { type: 'integer', description: '最大件数（1〜10）' },
        min_reviews: { type: 'integer', description: '最低レビュー数（0以上）' },
      },
      required: ['university_id', 'metric', 'order', 'limit', 'min_reviews'],
      additionalProperties: false,
    },
  },
];

/** ---------- tool実装（Supabaseで安全に実行） ---------- */
async function tool_get_my_affiliation(ctx: { userId: string }) {
  // user_affiliations は user_id で1行（最新所属）想定
  const { data, error } = await supabaseAdmin
    .from('user_affiliations')
    .select('university_id, faculty, department, universities(name)')
    .eq('user_id', ctx.userId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  return {
    university_id: data.university_id as string,
    university_name: (data as any).universities?.name ?? null,
    faculty: data.faculty as string,
    department: (data as any).department ?? null,
  };
}

async function tool_resolve_university(args: { university_name: string; limit: number }) {
  const raw = args.university_name?.trim() ?? '';
  const limit = Math.max(1, Math.min(10, args.limit || 5));
  if (!raw) return { picked: null, candidates: [] };

  // まず「完全一致」を優先（日本語なら eq でほぼOK）
  const { data: exact, error: exactErr } = await supabaseAdmin
    .from('universities')
    .select('id,name')
    .eq('name', raw)
    .maybeSingle();

  if (exactErr) throw exactErr;
  if (exact?.id) return { picked: exact as UniversityHit, candidates: [exact as UniversityHit] };

  // 次に部分一致（LIKEワイルドカード対策でエスケープ）
  const kw = escapeForLike(raw);
  const { data: hits, error } = await supabaseAdmin
    .from('universities')
    .select('id,name')
    .ilike('name', `%${kw}%`)
    .order('name', { ascending: true })
    .limit(limit);

  if (error) throw error;

  const candidates = (hits || []) as UniversityHit[];
  return {
    picked: candidates.length === 1 ? candidates[0] : null,
    candidates,
  };
}

async function tool_search_subjects_by_name(args: { university_id: string; keyword: string; limit: number }) {
  const keywordRaw = args.keyword?.trim() ?? '';
  const limit = Math.max(1, Math.min(20, args.limit || 10));
  if (!args.university_id || !keywordRaw) return [];

  const kw = escapeForLike(keywordRaw);

  const { data, error } = await supabaseAdmin
    .from('subjects')
    .select('id,name,university_id')
    .eq('university_id', args.university_id)
    .ilike('name', `%${kw}%`)
    .order('name', { ascending: true })
    .limit(limit);

  if (error) throw error;
  return (data || []) as SubjectHit[];
}

async function tool_get_subject_rollup(args: { subject_id: string }) {
  // 1) rollup本体（無い場合もある）
  const { data: rollup, error: rollErr } = await supabaseAdmin
    .from('subject_rollups')
    .select(
      'subject_id,summary_1000,review_count,avg_credit_ease,avg_class_difficulty,avg_assignment_load,avg_attendance_strictness,avg_satisfaction,avg_recommendation,is_dirty,updated_at'
    )
    .eq('subject_id', args.subject_id)
    .maybeSingle();

  if (rollErr) throw rollErr;

  // 2) subject名 + 大学名
  const { data: subj, error: subjErr } = await supabaseAdmin
    .from('subjects')
    .select('id,name,university_id,universities(name)')
    .eq('id', args.subject_id)
    .maybeSingle();

  if (subjErr) throw subjErr;

  // 3) 単位取得状況の簡易集計（performance_self）
  // - 2: 単位なし
  // - 3: 単位あり（普通）
  // - 4: 単位あり（高評価）
  // - 1: 未評価
  const { data: perfRows, error: perfErr } = await supabaseAdmin
    .from('course_reviews')
    .select('performance_self')
    .eq('subject_id', args.subject_id)
    .limit(5000);

  if (perfErr) throw perfErr;

  let notRated = 0;
  let noCredit = 0;
  let creditNormal = 0;
  let creditHigh = 0;

  for (const r of perfRows || []) {
    const v = (r as any).performance_self as number;
    if (v === 1) notRated += 1;
    else if (v === 2) noCredit += 1;
    else if (v === 3) creditNormal += 1;
    else if (v === 4) creditHigh += 1;
  }

  return {
    subject: {
      id: subj?.id ?? args.subject_id,
      name: (subj as any)?.name ?? null,
      university_id: (subj as any)?.university_id ?? null,
      university_name: (subj as any)?.universities?.name ?? null,
    },
    rollup: (rollup || null) as RollupRow | null,
    credit_outcomes: {
      not_rated: notRated,
      no_credit: noCredit,
      credit_normal: creditNormal,
      credit_high: creditHigh,
    },
  };
}

async function tool_top_subjects_by_metric(args: {
  university_id: string;
  metric:
    | 'avg_satisfaction'
    | 'avg_recommendation'
    | 'avg_class_difficulty'
    | 'avg_assignment_load'
    | 'avg_attendance_strictness'
    | 'avg_credit_ease';
  order: 'asc' | 'desc';
  limit: number;
  min_reviews: number;
}) {
  const limit = Math.max(1, Math.min(10, args.limit || 5));
  const minReviews = Math.max(0, args.min_reviews || 0);

  // rollups -> subjects を埋め込みselectし、大学IDで絞る
  const { data, error } = await supabaseAdmin
    .from('subject_rollups')
    .select(`subject_id,review_count,${args.metric},subjects(name,university_id)`)
    .gte('review_count', minReviews)
    .eq('subjects.university_id', args.university_id)
    .order(args.metric, { ascending: args.order === 'asc', nullsFirst: false })
    .limit(limit);

  if (error) throw error;

  return (data || []).map((r: any) => ({
    subject_id: r.subject_id,
    subject_name: r.subjects?.name ?? null,
    review_count: r.review_count,
    metric_value: r[args.metric] ?? null,
    metric: args.metric,
  }));
}

/** tool名→実装のルーター */
async function callTool(name: string, args: any, ctx: { userId: string }) {
  switch (name) {
    case 'get_my_affiliation':
      return await tool_get_my_affiliation(ctx);
    case 'resolve_university':
      return await tool_resolve_university(args);
    case 'search_subjects_by_name':
      return await tool_search_subjects_by_name(args);
    case 'get_subject_rollup':
      return await tool_get_subject_rollup(args);
    case 'top_subjects_by_metric':
      return await tool_top_subjects_by_metric(args);
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

/** ---------- メイン：Function Calling ループ ----------
 * Responses API では output に type:"function_call" が入り、call_id/name/arguments が返る。結果は type:"function_call_output" で返す。 :contentReference[oaicite:1]{index=1}
 */
async function runAgent(params: {
  userMessage: string;
  userId: string;
  memorySummary: string;
  recentChats: ChatRow[];
}) {
  const { userMessage, userId, memorySummary, recentChats } = params;

  // ここが「性格＋制約」
  const developerPrompt = `
あなたは「大学授業レビューDB」を根拠に回答できるアシスタント。

重要:
- DBに関する断定は、必ずツール結果に基づいて行う（推測で作らない）
- DBに関係ない雑談・一般知識の質問は、普通に会話してOK（ただし嘘の“DB事実”は言わない）

動き方（DB質問のとき）:
- 大学が不明で特定できないなら、まず大学名を聞き返す
  - ただし get_my_affiliation で大学が一意なら、その大学として検索してよい（その旨を明記）
- 科目が曖昧なら search_subjects_by_name で候補を出し、ユーザーに選ばせる
- rollup が無い / is_dirty=true / summaryが空 の場合は「集計中/データ不足」を正直に伝える
- 可能なら review_count と主要平均（満足度/おすすめ度/難易度）を添える
- 「単位落としてる割合」などは credit_outcomes を使い、母数も明記する
`.trim();

  // 会話の土台（要約＋直近ログ）
  const memoryBlock = memorySummary?.trim()
    ? `【ユーザー長期メモ（要約）】\n${memorySummary.trim()}`
    : `【ユーザー長期メモ（要約）】\n(まだ要約なし)`;

  // 直近ログを Responses の input 形式に変換
  const chatItems = recentChats.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  // 直近ログの末尾が「今のメッセージ」と同一なら、二重投入を避ける
  const last = recentChats[recentChats.length - 1];
  const shouldAppendUser =
    !(last && last.role === 'user' && (last.content ?? '').trim() === userMessage.trim());

  const input: any[] = [
    { role: 'developer', content: developerPrompt },
    { role: 'developer', content: memoryBlock },
    ...chatItems,
    ...(shouldAppendUser ? [{ role: 'user', content: userMessage }] : []),
  ];

  // 無限ループ防止：最大3往復
  for (let step = 0; step < 3; step++) {
    const resp = await openai.responses.create({
      model: QA_MODEL,
      input,
      tools,
      tool_choice: 'auto',
      parallel_tool_calls: false, // まずは単発で安定運用
    });

    // tool呼び出し抽出
    const calls = (resp.output || []).filter((o: any) => o.type === 'function_call');

    if (calls.length === 0) {
      // tool無し＝最終回答
      const text = (resp.output_text || '').trim();
      return text.length ? text : 'すみません、うまく回答を作れませんでした。もう一度言い換えてください。';
    }

    // tool実行→結果を function_call_output として input に追加
    for (const c of calls) {
      const name = c.name as string;
      const args = c.arguments ? JSON.parse(c.arguments) : {};

      try {
        const result = await callTool(name, args, { userId });

        input.push({
          type: 'function_call_output',
          call_id: c.call_id,
          output: JSON.stringify({ ok: true, result }),
        });
      } catch (e: any) {
        input.push({
          type: 'function_call_output',
          call_id: c.call_id,
          output: JSON.stringify({ ok: false, error: e?.message ?? String(e) }),
        });
      }
    }
  }

  return 'すみません、検索が複雑になりすぎました。大学名と科目名をもう少し具体的に教えてください。';
}

/** ---------- HTTPハンドラ ---------- */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as AskPayload;

    const message = body.message?.trim();
    if (!body.line_user_id) {
      return NextResponse.json({ ok: false, error: 'line_user_id is required' }, { status: 400 });
    }
    if (!message) {
      return NextResponse.json({ ok: false, error: 'message is required' }, { status: 400 });
    }

    // users.id（内部ID）を確定
    const userId = await getOrCreateUserId(body.line_user_id);

    // 会話文脈（要約＋直近ログ）を読む
    // ※ webhook 側でログを保存してる想定だが、直接叩いた時もあるのでここで読む
    let memorySummary = '';
    let recentChats: ChatRow[] = [];

    try {
      memorySummary = await getUserMemorySummary(userId);
    } catch (e) {
      // 失敗しても致命ではない（雑談はできる）
      console.error('[api/ask] getUserMemorySummary error:', e);
    }

    try {
      recentChats = await getRecentChatMessages(userId, 16);
    } catch (e) {
      console.error('[api/ask] getRecentChatMessages error:', e);
    }

    const answer = await runAgent({
      userMessage: message,
      userId,
      memorySummary,
      recentChats,
    });

    return NextResponse.json({ ok: true, user_id: userId, answer });
  } catch (e: any) {
    console.error('[api/ask] error:', e);
    return NextResponse.json(
      { ok: false, error: e?.message ?? 'server error', details: supabaseErrorToJson(e) },
      { status: 500 }
    );
  }
}
