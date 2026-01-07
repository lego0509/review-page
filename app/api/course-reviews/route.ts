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
      getOrCreateUserId(body.line_user_id),
      getOrCreateUniversityId(universityName),
    ]);

    // ----------------------------
    // 3) user_affiliations を最新状態として upsert
    // ----------------------------
    // 履歴を持たない運用（最新のみ保持）
    {
      const { error: affErr } = await supabaseAdmin
        .from('user_affiliations')
        .upsert(
          {
            user_id: userId,
            university_id: universityId,
            faculty,
            department,
          },
          { onConflict: 'user_id' }
        );

      if (affErr) {
        return NextResponse.json(
          { error: 'failed to upsert user_affiliations', details: supabaseErrorToJson(affErr) },
          { status: 500 }
        );
      }
    }

    // ----------------------------
    // 4) subject の確定（大学＋授業名で一意）
    // ----------------------------
    const subjectId = await getOrCreateSubjectId(universityId, subjectName);

    // ----------------------------
    // 5) course_reviews（本文以外）を insert
    // ----------------------------
    // 重要：
    // - course_reviews に university_id はもう無い（subject経由で取る）
    // - body_main は course_review_bodies に分離済み
    const { data: inserted, error: insReviewErr } = await supabaseAdmin
      .from('course_reviews')
      .insert({
        user_id: userId,
        subject_id: subjectId,

        faculty,
        department,
        grade_at_take: body.grade_at_take,

        // 教師は任意：未入力はNULLに統一（空配列でもOKだがノイズが増える）
        teacher_names: teacherNames.length > 0 ? teacherNames : null,

        academic_year: body.academic_year,
        term: body.term,
        credits_at_take: body.credits_at_take ?? null,
        requirement_type_at_take: body.requirement_type_at_take,

        performance_self: body.performance_self,
        assignment_difficulty_4: body.assignment_difficulty_4,

        credit_ease: body.credit_ease,
        class_difficulty: body.class_difficulty,
        assignment_load: body.assignment_load,
        attendance_strictness: body.attendance_strictness,
        satisfaction: body.satisfaction,
        recommendation: body.recommendation,
      })
      .select('id')
      .single();

    if (insReviewErr || !inserted?.id) {
      return NextResponse.json(
        { error: 'failed to insert course_reviews', details: supabaseErrorToJson(insReviewErr) },
        { status: 400 }
      );
    }

    insertedReviewId = inserted.id;

    // ----------------------------
    // 6) course_review_bodies（本文）を insert
    // ----------------------------
    // ここが失敗したら「本文なしレビュー」が残るので、必ず後始末する
    {
      const { error: bodyErr } = await supabaseAdmin.from('course_review_bodies').insert({
        review_id: insertedReviewId,
        body_main: comment,
      });

      if (bodyErr) {
        // 片肺データ防止：本体レビューを消す（bodiesはinsert失敗してるので存在しない）
        await supabaseAdmin.from('course_reviews').delete().eq('id', insertedReviewId);
        insertedReviewId = null;

        return NextResponse.json(
          { error: 'failed to insert course_review_bodies', details: supabaseErrorToJson(bodyErr) },
          { status: 400 }
        );
      }
    }

    // ----------------------------
    // 7) embedding_jobs を queued で積む
    // ----------------------------
    // バッチ処理は「jobsを見て処理する」想定にすると運用が楽。
    // - 未処理レビュー探索が確実
    // - リトライ/ロック/失敗管理がやりやすい
    {
      const { error: jobErr } = await supabaseAdmin
        .from('embedding_jobs')
        .upsert(
          {
            review_id: insertedReviewId,
            status: 'queued',
            attempt_count: 0,
            last_error: null,
            locked_at: null,
            locked_by: null,
          },
          { onConflict: 'review_id' }
        );

      if (jobErr) {
        // ここで落ちると「レビューはあるのにジョブが無い」状態になって後で面倒
        // 編集機能なし運用なら潔くロールバックでOK
        await supabaseAdmin.from('course_reviews').delete().eq('id', insertedReviewId);
        insertedReviewId = null;

        return NextResponse.json(
          { error: 'failed to upsert embedding_jobs', details: supabaseErrorToJson(jobErr) },
          { status: 500 }
        );
      }
    }

    // ----------------------------
    // 8) subject_rollups を dirty にする
    // ----------------------------
    // 投稿時点では集計・要約は更新しない（遅い/失敗がUX悪化）
    // バッチが is_dirty=true を拾って集計(avg/count/summary)を更新する
    {
      const { error: rollErr } = await supabaseAdmin
        .from('subject_rollups')
        .upsert(
          {
            subject_id: subjectId,
            is_dirty: true,
          },
          { onConflict: 'subject_id' }
        );

      if (rollErr) {
        // dirtyが立たないと rollups更新が走らないので、これもロールバックで揃える
        await supabaseAdmin.from('course_reviews').delete().eq('id', insertedReviewId);
        insertedReviewId = null;

        return NextResponse.json(
          { error: 'failed to upsert subject_rollups', details: supabaseErrorToJson(rollErr) },
          { status: 500 }
        );
      }
    }

    // 成功レスポンス
    return NextResponse.json({ ok: true, review_id: insertedReviewId });
  } catch (e: any) {
    // 予期しない例外（JSON parse失敗やsupabaseのthrowなど）
    console.error('[course-reviews] POST error:', e);

    // 例外でも片肺防止：reviewだけ作れてる可能性があるので削除を試みる
    if (insertedReviewId) {
      try {
        await supabaseAdmin.from('course_reviews').delete().eq('id', insertedReviewId);
      } catch {
        // ここでさらにエラー出ても、APIレスポンスの邪魔なので握りつぶす
      }
    }

    return NextResponse.json({ error: e?.message ?? 'server error' }, { status: 500 });
  }
}
