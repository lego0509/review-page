export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { createHmac } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

/**
 * term / requirement は DB の CHECK 制約と合わせる。
 * → ここがズレると insert が 400 で落ちる。
 */
type TermCode = 's1' | 's2' | 'q1' | 'q2' | 'q3' | 'q4' | 'full' | 'intensive' | 'other';
type RequirementType = 'required' | 'elective' | 'unknown';

type Payload = {
  // LIFFから来るLINEユーザーID（生IDをDB保存しない）
  line_user_id: string;

  // 大学名（universitiesへ getOrCreate）
  university_name: string;

  // 所属（user_affiliationsを最新にupsertするために必須）
  faculty: string;
  department?: string | null;
  grade_at_take: number; // 1..6 or 99

  // 授業名（subjectsへ getOrCreate）
  subject_name: string;

  /**
   * 教師名：任意
   * - DB側は teacher_names_optional_valid() で NULL / 空配列OK
   * - 入ってるなら要素の空白/NULLはNG
   */
  teacher_names?: string[] | null;

  // 受講時期（同一科目に複数レビューを許容するため識別軸）
  academic_year: number;
  term: TermCode;

  // その他メタ
  credits_at_take?: number | null;
  requirement_type_at_take: RequirementType;

  // 自己評価系
  performance_self: number; // 1..4
  assignment_difficulty_4: number; // 1..4

  // 5段階評価（DB側チェックあり）
  credit_ease: number; // 1..5
  class_difficulty: number; // 1..5
  assignment_load: number; // 1..5
  attendance_strictness: number; // 1..5
  satisfaction: number; // 1..5
  recommendation: number; // 1..5

  /**
   * 本文：DBでは course_review_bodies に分離
   * - 30文字以上制約は bodies 側で担保
   */
  body_main: string;
};

/**
 * LINE userId を HMAC-SHA256(pepper) でハッシュ化して hex(64) を作る
 * - “pepperが違う” と userが別人扱いで全崩壊するので、環境変数未設定は即例外
 */
function lineUserIdToHash(lineUserId: string) {
  const pepper = process.env.LINE_HASH_PEPPER;
  if (!pepper) {
    throw new Error('LINE_HASH_PEPPER is not set');
  }
  return createHmac('sha256', pepper).update(lineUserId, 'utf8').digest('hex');
}

/**
 * Supabaseのエラーを JSON で返しやすい形にしてログ/レスポンスへ
 * - 卒研のデバッグで「どの制約で落ちたか」追いやすくなる
 */
function supabaseErrorToJson(err: any) {
  if (!err) return null;
  return {
    message: err.message,
    code: err.code,
    details: err.details,
    hint: err.hint,
  };
}

/**
 * universities から name で探して、無ければ insert する
 * - UNIQUE(name) を貼ってるので同時投稿で競合する可能性がある
 * - 競合(23505)なら再検索してIDを取る
 */
async function getOrCreateUniversityId(name: string) {
  const { data: found, error: findErr } = await supabaseAdmin
    .from('universities')
    .select('id')
    .eq('name', name)
    .maybeSingle();

  if (findErr) throw findErr;
  if (found?.id) return found.id;

  const { data: inserted, error: insErr } = await supabaseAdmin
    .from('universities')
    .insert({ name })
    .select('id')
    .single();

  // unique違反（同時投稿）対策：負けた側は再取得して整合
  if (insErr && (insErr as any).code === '23505') {
    const { data: again, error: againErr } = await supabaseAdmin
      .from('universities')
      .select('id')
      .eq('name', name)
      .single();

    if (againErr) throw againErr;
    if (!again) throw new Error('university conflict retry failed');
    return again.id;
  }

  if (insErr) throw insErr;
  return inserted.id;
}

/**
 * subjects を (university_id, name) で探して無ければ insert
 * - DBに UNIQUE(university_id, name) がある前提
 * - 同時投稿競合(23505)なら再検索
 */
async function getOrCreateSubjectId(universityId: string, subjectName: string) {
  const { data: found, error: findErr } = await supabaseAdmin
    .from('subjects')
    .select('id')
    .eq('university_id', universityId)
    .eq('name', subjectName)
    .maybeSingle();

  if (findErr) throw findErr;
  if (found?.id) return found.id;

  const { data: inserted, error: insErr } = await supabaseAdmin
    .from('subjects')
    .insert({ university_id: universityId, name: subjectName })
    .select('id')
    .single();

  // UNIQUE(university_id, name) 競合対策
  if (insErr && (insErr as any).code === '23505') {
    const { data: again, error: againErr } = await supabaseAdmin
      .from('subjects')
      .select('id')
      .eq('university_id', universityId)
      .eq('name', subjectName)
      .single();

    if (againErr) throw againErr;
    if (!again) throw new Error('subject conflict retry failed');
    return again.id;
  }

  if (insErr) throw insErr;
  return inserted.id;
}

/**
 * users を line_user_hash で探して無ければ insert
 * - 生のLINE userIdはDBに保存しない
 * - 競合時は再検索で整合を取る
 */
async function getOrCreateUserId(lineUserId: string) {
  const hash = lineUserIdToHash(lineUserId);

  const { data: found, error: findErr } = await supabaseAdmin
    .from('users')
    .select('id')
    .eq('line_user_hash', hash)
    .maybeSingle();

  if (findErr) throw findErr;
  if (found?.id) return found.id;

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
    return again.id;
  }

  if (insErr) throw insErr;
  return inserted.id;
}

export async function POST(req: Request) {
  /**
   * 途中で失敗したときに「レビュー本体だけ残る」事故を防ぐため、
   * insertしたreview_idを控えておく（cleanup用）
   */
  let insertedReviewId: string | null = null;

  try {
    // 受信JSONをPayloadとして扱う（この段階では信用しない）
    const body = (await req.json()) as Payload;

    // テキスト系は前処理でtrimしておく（DBのbtrimチェックに寄せる）
    const universityName = body.university_name?.trim();
    const faculty = body.faculty?.trim();
    const department = body.department?.trim() || null;
    const subjectName = body.subject_name?.trim();

    // 教師は任意：配列が来ても空白は落とす。未入力は空配列になる。
    const teacherNames = (body.teacher_names ?? [])
      .map((s) => (s ?? '').trim())
      .filter(Boolean);

    // 本文（bodies側で30文字制約があるが、API側でも先に弾いてUXを良くする）
    const comment = body.body_main?.trim();

    // ----------------------------
    // 1) 最低限の入力チェック
    // ----------------------------
    // （数値範囲の細かい検証はDB制約に任せる。APIで二重に書くとメンテ死ぬ）
    if (!body.line_user_id) {
      return NextResponse.json({ error: 'line_user_id is required' }, { status: 400 });
    }
    if (!universityName || !faculty || !subjectName) {
      return NextResponse.json({ error: 'missing required text' }, { status: 400 });
    }
    // 教師は任意なのでここでは弾かない
    if (!comment || comment.length < 30) {
      return NextResponse.json({ error: 'comment must be >= 30 chars' }, { status: 400 });
    }

    // ----------------------------
    // 2) user と university の確定
    // ----------------------------
    // 並列実行できるので Promise.all
    const [userId, universityId] = await Promise.all([
