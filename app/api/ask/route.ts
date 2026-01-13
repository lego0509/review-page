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
 * ※「自由なSQL」は絶対やらない。必ず “用意した関数（ツール）” だけ実行する。
 */

/** ---------- 環境変数 ---------- */
function requireEnv(name: string, value?: string | null) {
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const OPENAI_API_KEY = requireEnv('OPENAI_API_KEY', process.env.OPENAI_API_KEY);
const QA_MODEL = process.env.OPENAI_QA_MODEL || 'gpt-5-mini';
const LINE_HASH_PEPPER = requireEnv('LINE_HASH_PEPPER', process.env.LINE_HASH_PEPPER);

/**
 * ASK_DEBUG=1 なら、レスポンスに tool 呼び出し履歴を載せる（LINE運用では 0 推奨）
 * もしくは header x-ask-debug: 1 で強制ON
 */
const ASK_DEBUG = process.env.ASK_DEBUG === '1';

/** ---------- OpenAI client ---------- */
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/** ---------- 型（最低限） ---------- */
type AskPayload = {
  line_user_id: string;
  message: string;
  // 開発中にだけ使いたい場合（任意）
  debug?: boolean;
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

/**
 * Responses API の output は union 型で TS がうるさいので、
 * function_call だけを「安全に読む」ための型を用意しておく。
 */
type FunctionCallItem = {
  type: 'function_call';
  name: string;
  arguments?: string;
  call_id: string;
};

/** ---------- ここが “プロンプト” の定義（見失わないように上部へ） ---------- */
/**
 * =========================================================
 * ★ PROMPT(1) : developerPrompt（モデルの性格と制約）
 * =========================================================
 * - 「DB根拠で答えろ」「大学不明なら聞き返せ」などのルールを固定する場所
 * - ここが “DB検索する／しない” の判断精度に直結する
 */
const PROMPT_DEVELOPER = `
あなたは「大学授業レビューDB」を根拠に回答するアシスタント。
必ずツールで取得した事実に基づいて答える（推測で断定しない）。

【絶対ルール】
- DBに存在しない情報（一般的なネット知識）で、特定の授業/大学を断定しておすすめしない。
- 数字（満足度/おすすめ度/難易度/単位落とす割合など）を出すときは、必ずツール結果に基づく。
- ツール結果が無いのに「DBでは〜」と言ってはいけない。

【会話制御】
- 大学が不明で特定できないなら、まず大学を聞き返す。
  ただし get_my_affiliation が取れて大学が一意なら、その大学として検索してよい（その旨を回答に明記）。
- 科目が曖昧なら、search_subjects_by_name で候補を出してユーザーに選ばせる。
- rollup が存在しない / is_dirty=true / summaryが空などの場合は「集計中/データ不足」を正直に伝える。
- 回答には可能なら review_count と主要な平均値（満足度/おすすめ度/難易度）を添える。
- 「単位落としてる割合」などは credit_outcomes を使って説明する（母数も書く）。

【出力の雰囲気】
- LINE想定。長文になりすぎない。必要なら箇条書き。
- 最後に、今回参照した根拠を短く付ける（例：レビュー数、対象大学名、対象科目名）。
`;

/**
 * =========================================================
 * ★ PROMPT(2) : instructions（Responses API の追加指示）
 * =========================================================
 * - developerPrompt と役割が近いが、こちらは「この呼び出しでの追加制約」
 * - “ツールを使わずにDBっぽい断定をしない” をさらに強くする
 *
 * ※SDKの型・モデル差分で挙動が変わることがあるので、ここは短め&明確にするのが安定
 */
const PROMPT_INSTRUCTIONS = `
あなたは授業レビューDBに基づく回答のみ行う。
DB参照が必要な質問では、必ず tools を呼び出してから回答する。
ツール結果が無い場合は「大学名を教えて」など必要情報を聞き返す。
`;

/**
 * DBが必要そうな質問なのに tool を呼ばない事故があるので、
 * “っぽい質問” は tool_choice='required' を使って強制する（保険）
 */
function shouldForceTool(userMessage: string) {
  const t = userMessage.toLowerCase();

  // 雑でも効果が高いキーワード群（あなたのドメインに合わせて足してOK）
  const keywords = [
    '授業',
    '科目',
    'おすすめ',
    'レビュー',
    '満足',
    'おすすめ度',
    '難易度',
    '出席',
    '課題',
    '単位',
    '落と',
    'トップ',
    'ランキング',
    '平均',
    'rollup',
    'summary',
  ];

  return keywords.some((k) => t.includes(k));
}

/** ---------- util ---------- */
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
 * openai sdk の型に合わせて「function」ネストなしの形式で書く：
 * { type:'function', name, description, strict, parameters }
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
    description: '指定大学の subjects から科目名の部分一致で検索して候補を返す（曖昧なときの候補出し用）。',
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
    description: 'subject_id を指定して subject_rollups + 科目名 + 大学名を返す。必要なら単位取得状況も返す。',
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
    description: '指定大学の subject_rollups から、指標で上位/下位の科目を返す（おすすめ/難しい授業など）。',
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
  const name = (args.university_name ?? '').trim();
  const limit = Math.max(1, Math.min(10, args.limit || 5));

  if (!name) return { picked: null, candidates: [] as UniversityHit[] };

  // 完全一致（大小無視）っぽく優先：ilike でワイルドカード無し
  const { data: exact, error: exactErr } = await supabaseAdmin
    .from('universities')
    .select('id,name')
    .ilike('name', name)
    .maybeSingle();

  if (exactErr) throw exactErr;
  if (exact?.id) return { picked: exact as UniversityHit, candidates: [exact as UniversityHit] };

  // 部分一致候補
  const { data: hits, error } = await supabaseAdmin
    .from('universities')
    .select('id,name')
    .ilike('name', `%${name}%`)
    .order('name', { ascending: true })
    .limit(limit);

  if (error) throw error;

  const candidates = (hits || []) as UniversityHit[];
  return { picked: candidates.length === 1 ? candidates[0] : null, candidates };
}

async function tool_search_subjects_by_name(args: { university_id: string; keyword: string; limit: number }) {
  const universityId = args.university_id;
  const keyword = (args.keyword ?? '').trim();
  const limit = Math.max(1, Math.min(20, args.limit || 10));

  if (!universityId || !keyword) return [] as SubjectHit[];

  const { data, error } = await supabaseAdmin
    .from('subjects')
    .select('id,name,university_id')
    .eq('university_id', universityId)
    .ilike('name', `%${keyword}%`)
    .order('name', { ascending: true })
    .limit(limit);

  if (error) throw error;

  return (data || []) as SubjectHit[];
}

/**
 * rollups に「単位取得状況カウント」が載ってる設計に進化してても壊れないように：
 * - rollup は select('*') にして、キーがあればそれを使う
 * - 無ければ course_reviews を軽く集計して埋める（保険）
 */
function pickNumber(obj: any, keys: string[]) {
  for (const k of keys) {
    if (typeof obj?.[k] === 'number') return obj[k] as number;
  }
  return null;
}

async function tool_get_subject_rollup(args: { subject_id: string }) {
  const subjectId = args.subject_id;

  // 1) rollup本体（列増減に強くするため * で取る）
  const { data: rollup, error: rollErr } = await supabaseAdmin
    .from('subject_rollups')
    .select('*')
    .eq('subject_id', subjectId)
    .maybeSingle();

  if (rollErr) throw rollErr;

  // 2) subject + university 名
  const { data: subj, error: subjErr } = await supabaseAdmin
    .from('subjects')
    .select('id,name,university_id,universities(name)')
    .eq('id', subjectId)
    .maybeSingle();

  if (subjErr) throw subjErr;

  // 3) 単位取得状況（rollups にカラムがあればそれを使う／無ければ保険で集計）
  let noCredit = null as number | null;
  let creditNormal = null as number | null;
  let creditHigh = null as number | null;
  let notRated = null as number | null;

  if (rollup) {
    noCredit = pickNumber(rollup, ['no_credit', 'no_credit_count', 'count_no_credit', 'cnt_no_credit']);
    creditNormal = pickNumber(rollup, ['credit_normal', 'credit_normal_count', 'count_credit_normal', 'cnt_credit_normal']);
    creditHigh = pickNumber(rollup, ['credit_high', 'credit_high_count', 'count_credit_high', 'cnt_credit_high']);
    notRated = pickNumber(rollup, ['not_rated', 'not_rated_count', 'count_not_rated', 'cnt_not_rated']);
  }

  // rollup 側に無かったら（or null）最低限だけ集計（上限つき）
  if (noCredit === null || creditNormal === null || creditHigh === null || notRated === null) {
    const { data: perfRows, error: perfErr } = await supabaseAdmin
      .from('course_reviews')
      .select('performance_self')
      .eq('subject_id', subjectId)
      .limit(5000);

    if (perfErr) throw perfErr;

    let _notRated = 0;
    let _noCredit = 0;
    let _creditNormal = 0;
    let _creditHigh = 0;

    for (const r of perfRows || []) {
      const v = (r as any).performance_self as number;
      if (v === 1) _notRated += 1;
      else if (v === 2) _noCredit += 1;
      else if (v === 3) _creditNormal += 1;
      else if (v === 4) _creditHigh += 1;
    }

    if (notRated === null) notRated = _notRated;
    if (noCredit === null) noCredit = _noCredit;
    if (creditNormal === null) creditNormal = _creditNormal;
    if (creditHigh === null) creditHigh = _creditHigh;
  }

  return {
    subject: {
      id: subj?.id ?? subjectId,
      name: subj?.name ?? null,
      university_id: subj?.university_id ?? null,
      university_name: (subj as any)?.universities?.name ?? null,
    },
    rollup: (rollup || null) as RollupRow | null,
    credit_outcomes: {
      not_rated: notRated ?? 0,
      no_credit: noCredit ?? 0,
      credit_normal: creditNormal ?? 0,
      credit_high: creditHigh ?? 0,
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
  const universityId = args.university_id;
  const limit = Math.max(1, Math.min(10, args.limit || 5));
  const minReviews = Math.max(0, args.min_reviews || 0);

  if (!universityId) return [];

  const { data, error } = await supabaseAdmin
    .from('subject_rollups')
    .select(`subject_id,review_count,${args.metric},subjects(name,university_id)`)
    .gte('review_count', minReviews)
    .order(args.metric, { ascending: args.order === 'asc', nullsFirst: false })
    .limit(limit);

  if (error) throw error;

  // 大学で絞り込み（join結果の subjects.university_id）
  const filtered = (data || []).filter((r: any) => r.subjects?.university_id === universityId);

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

  // ★ここが “判断させる指示” の本体（プロンプト）
  const developerPrompt = `
あなたは「大学授業レビューDB」を根拠に回答するアシスタント。
授業・科目・大学に関する質問は、必ずツールで取得した事実に基づいて答えること。
ツールを呼ばずに一般知識で答えるのは禁止。データが取れない場合は「不明/要確認」と言い、必要なら聞き返す。

ルール：
- 大学が不明で特定できないなら、まず大学を聞き返す。
  ただし get_my_affiliation で大学が一意に取れたなら、その大学として検索してよい（その旨を回答に明記）。
- 大学名が書かれている場合は resolve_university で候補を確定する。
- 科目が曖昧なら search_subjects_by_name で候補を出してユーザーに選ばせる。
- 「おすすめ上位」「難しい上位」などランキング系は top_subjects_by_metric を使う。
- 個別科目の詳細は get_subject_rollup を使う。
- rollup が無い / is_dirty=true / summaryが空などは「集計中/データ不足」を正直に伝える。
- 回答には可能なら review_count と主要な平均値（満足度/おすすめ度/難易度）を添える。
- 「単位落としてる割合」などは credit_outcomes を使って説明する（母数も書く）。
`.trim();

  // 1) 最初の問い合わせ（developer+user を渡す）
  let resp = await openai.responses.create({
    model: QA_MODEL,
    input: [
      { role: 'developer', content: developerPrompt },
      { role: 'user', content: userMessage },
    ],
    tools,
    tool_choice: 'auto',
    parallel_tool_calls: false,
  });

  // ★ここが超重要：tool output は「直前の response」に紐づける必要がある
  let previousResponseId = resp.id;

  // 無限ループ防止（最大5回）
  for (let step = 0; step < 5; step++) {
    const calls = ((resp as any).output || []).filter(
      (o: any) => o?.type === 'function_call'
    ) as FunctionCallItem[];

    // tool呼び出しが無い = 最終回答
    if (calls.length === 0) {
      const text = (resp.output_text || '').trim();
      return text.length
        ? text
        : 'すみません、うまく回答を作れませんでした。大学名と科目名をもう少し具体的に教えてください。';
    }

    // 2) tool を実行して outputs を作る（ここだけを次の input に渡す）
    const toolOutputs: any[] = [];

    for (const c of calls) {
      const name = c.name;
      let args: any = {};
      try {
        args = c.arguments ? JSON.parse(c.arguments) : {};
      } catch {
        args = {};
      }

      // （任意）デバッグログ：DBを見に行ってるか確認したいとき用
      if (process.env.DEBUG_ASK === '1') {
        console.log('[ask] tool_call:', name, args);
      }

      try {
        const result = await callTool(name, args, { userId });

        toolOutputs.push({
          type: 'function_call_output',
          call_id: c.call_id,
          output: JSON.stringify({ ok: true, result }),
        });
      } catch (e: any) {
        toolOutputs.push({
          type: 'function_call_output',
          call_id: c.call_id,
          output: JSON.stringify({ ok: false, error: e?.message ?? String(e) }),
        });
      }
    }

    // 3) ★前の response に紐づけて toolOutputs を送る
    resp = await openai.responses.create({
      model: QA_MODEL,
      previous_response_id: previousResponseId,
      input: toolOutputs,
      tools,
      tool_choice: 'auto',
      parallel_tool_calls: false,
    });

    previousResponseId = resp.id;
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

    const debug =
      ASK_DEBUG || body.debug === true || req.headers.get('x-ask-debug') === '1';

    // users.id（内部ID）を確定
    const userId = await getOrCreateUserId(body.line_user_id);

    // ここでは「会話ログ保存」は webhook 側でやる前提
    const r = await runAgent({ userMessage: message, userId });

    // debug時だけ “DB見たか” が分かる情報を返す
    return NextResponse.json({
      ok: true,
      user_id: userId,
      answer: r,
      ...(debug ? { debug: { forced_tool: r.forced, tool_calls: r.toolTrace } } : {}),
    });
  } catch (e: any) {
    console.error('[api/ask] error:', e);
    return NextResponse.json({ ok: false, error: e?.message ?? 'server error' }, { status: 500 });
  }
}
