export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import { createHmac } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

/**
 * ---------------------------------------
 * /api/ask の責務（最低限）
 * ---------------------------------------
 * - ユーザーの自然文質問を受け取る
 * - OpenAI(Responses API) に tools(function calling) を渡す
 * - モデルが要求した tool を Supabase で実行
 * - 結果を function_call_output としてモデルへ返す
 * - モデルの最終回答（または聞き返し）を返す
 *
 * ※ 「自由なSQL」は絶対やらない。必ず “用意した関数（ツール）” だけ実行する。
 */

/** ---------- 環境変数 ---------- */
function requireEnv(name: string, value?: string | null) {
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const OPENAI_API_KEY = requireEnv('OPENAI_API_KEY', process.env.OPENAI_API_KEY);
const QA_MODEL = process.env.OPENAI_QA_MODEL || 'gpt-5-mini'; // ここは好みで
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

function lineUserIdToHash(lineUserId: string) {
  // LINEのuserIdはDBに生で保存しない（ハッシュ化）
  return createHmac('sha256', LINE_HASH_PEPPER).update(lineUserId, 'utf8').digest('hex');
}

function supabaseErrorToJson(err: any) {
  if (!err) return null;
  return { message: err.message, code: err.code, details: err.details, hint: err.hint };
}

/** ---------- DBユーティリティ（ユーザーID確定） ---------- */
async function getOrCreateUserId(lineUserId: string) {
  const hash = lineUserIdToHash(lineUserId);

  // 既存ユーザー検索
  const { data: found, error: findErr } = await supabaseAdmin
    .from('users')
    .select('id')
    .eq('line_user_hash', hash)
    .maybeSingle();

  if (findErr) throw findErr;
  if (found?.id) return found.id as string;

  // 新規作成（同時投稿のunique競合に備えてリトライ）
  const { data: inserted, error: insErr } = await supabaseAdmin
    .from('users')
    .insert({ line_user_hash: hash })
    .select('id')
    .single();

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

/** ---------- tools（Function Calling）定義 ---------- */
/**
 * strict: true を使うと、JSON schemaにきっちり合わせて呼んでくれる（ズレが減る）
 * - additionalProperties:false が必要
 * - required に全フィールドが必要（任意にしたい場合は type:["string","null"] みたいにする） :contentReference[oaicite:1]{index=1}
 */
const tools: OpenAI.Responses.Tool[] = [
  {
    type: 'function',
    name: 'get_my_affiliation',
    description:
      'ユーザーの登録済み所属（大学/学部/学科）を返す。未登録なら null を返す。',
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
    description:
      '大学名から universities を検索して候補を返す。完全一致があればそれを優先する。',
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
      'subject_id を指定して subject_rollups + 科目名 + 大学名を返す。必要なら単位取得状況も course_reviews から集計して返す。',
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
  // user_affiliations: user_id が主キー想定（1ユーザー=最新所属1件）
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
    department: data.department as string | null,
  };
}

async function tool_resolve_university(args: { university_name: string; limit: number }) {
  const name = args.university_name.trim();
  const limit = Math.max(1, Math.min(10, args.limit || 5));

  // まず完全一致（大小無視）を優先
  const { data: exact, error: exactErr } = await supabaseAdmin
    .from('universities')
    .select('id,name')
    .ilike('name', name)
    .maybeSingle();

  if (exactErr) throw exactErr;
  if (exact?.id) {
    return { picked: exact, candidates: [exact] };
  }

  // 次に部分一致候補
  const { data: hits, error } = await supabaseAdmin
    .from('universities')
    .select('id,name')
    .ilike('name', `%${name}%`)
    .order('name', { ascending: true })
    .limit(limit);

  if (error) throw error;

  const candidates = (hits || []) as UniversityHit[];
  return {
    picked: candidates.length === 1 ? candidates[0] : null,
    candidates,
  };
}

async function tool_search_subjects_by_name(args: {
  university_id: string;
  keyword: string;
  limit: number;
}) {
  const keyword = args.keyword.trim();
  const limit = Math.max(1, Math.min(20, args.limit || 10));

  const { data, error } = await supabaseAdmin
    .from('subjects')
    .select('id,name,university_id')
    .eq('university_id', args.university_id)
    .ilike('name', `%${keyword}%`)
    .order('name', { ascending: true })
    .limit(limit);

  if (error) throw error;

  // rollupsのreview_countも一緒に返したいならここで追加クエリする（最低限なので省略）
  return (data || []) as SubjectHit[];
}

async function tool_get_subject_rollup(args: { subject_id: string }) {
  // 1) rollup本体
  const { data: rollup, error: rollErr } = await supabaseAdmin
    .from('subject_rollups')
    .select(
      'subject_id,summary_1000,review_count,avg_credit_ease,avg_class_difficulty,avg_assignment_load,avg_attendance_strictness,avg_satisfaction,avg_recommendation,is_dirty,updated_at'
    )
    .eq('subject_id', args.subject_id)
    .maybeSingle();

  if (rollErr) throw rollErr;

  // rollupsが無い（まだ未作成/未upsert）の場合もある
  // その場合は subject名だけでも返して、AI側が「まだ集計が無い」を言えるようにする
  const { data: subj, error: subjErr } = await supabaseAdmin
    .from('subjects')
    .select('id,name,university_id,universities(name)')
    .eq('id', args.subject_id)
    .maybeSingle();

  if (subjErr) throw subjErr;

  // 2) 「単位取得状況」系（performance_self）を最小で集計
  // - 2: 単位なし
  // - 3: 単位あり（普通）
  // - 4: 単位あり（高評価）
  // - 1: 未評価（参考用）
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
      name: subj?.name ?? null,
      university_id: subj?.university_id ?? null,
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

  // rollups -> subjects を join して科目名を取る
  // PostgRESTの埋め込みselectで subjects(name) が取れる想定
  const { data, error } = await supabaseAdmin
    .from('subject_rollups')
    .select(
      `subject_id,review_count,${args.metric},subjects(name,university_id)`
    )
    .gte('review_count', minReviews)
    .order(args.metric, { ascending: args.order === 'asc', nullsFirst: false })
    .limit(limit);

  if (error) throw error;

  // 大学で絞り込み（join結果のsubjects.university_idでフィルタ）
  const filtered = (data || []).filter((r: any) => r.subjects?.university_id === args.university_id);

  return filtered.map((r: any) => ({
    subject_id: r.subject_id,
    subject_name: r.subjects?.name ?? null,
    review_count: r.review_count,
    metric_value: r[args.metric] ?? null,
    metric: args.metric,
  }));
}

/** tool名→実装 のルーター */
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

/** ---------- メイン：Function Calling ループ ---------- */
async function runAgent(params: { userMessage: string; userId: string }) {
  const { userMessage, userId } = params;

  // モデルへの指示（ここが “性格” と “制約” の中心）
  const developerPrompt = `
あなたは「大学授業レビューDB」を根拠に回答するアシスタント。
必ずツールで取得した事実に基づいて答える（推測で断定しない）。

ルール：
- 大学が不明で特定できないなら、まず大学を聞き返す。
  ただし get_my_affiliation が取れて大学が一意なら、その大学として検索してよい（その旨を回答に明記）。
- 科目が曖昧なら、search_subjects_by_name で候補を出してユーザーに選ばせる。
- rollup が存在しない / is_dirty=true / summaryが空などの場合は「集計中/データ不足」を正直に伝える。
- 回答には可能なら review_count と主要な平均値（満足度/おすすめ度/難易度）を添える。
- 「単位落としてる割合」などは credit_outcomes を使って説明する（母数も書く）。
`;

  // Responses API の input は「会話の流れ」を配列で渡す
  const input: any[] = [
    { role: 'developer', content: developerPrompt },
    { role: 'user', content: userMessage },
  ];

  // 無限ループ防止：最大3回まで tool 往復
  for (let step = 0; step < 3; step++) {
    const resp = await openai.responses.create({
      model: QA_MODEL,
      input,
      tools,
      tool_choice: 'auto',
      parallel_tool_calls: false, // まずは単発ツールにしてデバッグ簡単にする
    });

    // 1) tool呼び出しがあるか確認（output配列に type:"function_call" が入る） :contentReference[oaicite:2]{index=2}
    const calls = (resp.output || []).filter((o: any) => o.type === 'function_call');

    if (calls.length === 0) {
      // 2) tool呼び出しが無い = これが最終回答
      const text = (resp.output_text || '').trim();
      return text.length ? text : 'すみません、うまく回答を作れませんでした。もう一度言い換えてください。';
    }

    // 3) toolを実行して結果を input に積む
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

    // （任意）チャットログ保存：必要なら有効化
    // await supabaseAdmin.from('chat_messages').insert({ user_id: userId, role: 'user', content: message });

    const answer = await runAgent({ userMessage: message, userId });

    // （任意）チャットログ保存：必要なら有効化
    // await supabaseAdmin.from('chat_messages').insert({ user_id: userId, role: 'assistant', content: answer });

    return NextResponse.json({ ok: true, user_id: userId, answer });
  } catch (e: any) {
    console.error('[api/ask] error:', e);
    return NextResponse.json({ ok: false, error: e?.message ?? 'server error' }, { status: 500 });
  }
}
