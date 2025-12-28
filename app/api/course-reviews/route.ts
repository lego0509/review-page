export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

type TermCode = 's1' | 's2' | 'q1' | 'q2' | 'q3' | 'q4' | 'full' | 'intensive' | 'other';
type RequirementType = 'required' | 'elective' | 'unknown';

type Payload = {
  line_user_id: string;

  university_name: string;
  faculty: string;
  department?: string | null;
  grade_at_take: number; // 1..6 or 99

  subject_name: string;
  teacher_names: string[];

  academic_year: number;
  term: TermCode;

  credits_at_take?: number | null;
  requirement_type_at_take: RequirementType;

  performance_self: number; // 1..4
  assignment_difficulty_4: number; // 1..4

  credit_ease: number;
  class_difficulty: number;
  assignment_load: number;
  attendance_strictness: number;
  satisfaction: number;
  recommendation: number;

  body_main: string; // >=30
};

function sha256Hex(input: string) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

function supabaseErrorToJson(err: any) {
  if (!err) return null;
  return {
    message: err.message,
    code: err.code,
    details: err.details,
    hint: err.hint,
  };
}

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

  // unique違反（同時投稿）対策
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

async function getOrCreateUserId(lineUserId: string) {
  const hash = sha256Hex(lineUserId);

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
  try {
    const body = (await req.json()) as Payload;

    const universityName = body.university_name?.trim();
    const faculty = body.faculty?.trim();
    const department = body.department?.trim() || null;
    const subjectName = body.subject_name?.trim();
    const teacherNames = (body.teacher_names ?? []).map((s) => s.trim()).filter(Boolean);
    const comment = body.body_main?.trim();

    // 最低限の入力チェック（細かい数値範囲はDB制約に任せてOK）
    if (!body.line_user_id) {
      return NextResponse.json({ error: 'line_user_id is required' }, { status: 400 });
    }
    if (!universityName || !faculty || !subjectName) {
      return NextResponse.json({ error: 'missing required text' }, { status: 400 });
    }
    if (teacherNames.length < 1) {
      return NextResponse.json({ error: 'teacher_names is required' }, { status: 400 });
    }
    if (!comment || comment.length < 30) {
      return NextResponse.json({ error: 'comment must be >= 30 chars' }, { status: 400 });
    }

    // user / university を先に確定
    const [userId, universityId] = await Promise.all([
      getOrCreateUserId(body.line_user_id),
      getOrCreateUniversityId(universityName),
    ]);

    // ここで user_affiliations を upsert（最新所属として保存）
    {
      const { error: affErr } = await supabaseAdmin
        .from('user_affiliations')
        .upsert(
          {
            user_id: userId,
            university_id: universityId,
            faculty,
            department,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'user_id' }
        );

      if (affErr) {
        // 所属保存は重要なので、失敗したら止める（ここは妥協しない）
        return NextResponse.json(
          { error: 'failed to upsert user_affiliations', details: supabaseErrorToJson(affErr) },
          { status: 500 }
        );
      }
    }

    // subject 確定
    const subjectId = await getOrCreateSubjectId(universityId, subjectName);

    // course_reviews insert
    const { data: inserted, error: insReviewErr } = await supabaseAdmin
      .from('course_reviews')
      .insert({
        user_id: userId,
        subject_id: subjectId,

        university_id: universityId,
        faculty,
        department,
        grade_at_take: body.grade_at_take,

        teacher_names: teacherNames,

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

        body_main: comment,
      })
      .select('id')
      .single();

    if (insReviewErr) {
      // DB制約違反などは 400（クライアント入力の問題）で返す
      return NextResponse.json(
        { error: 'failed to insert course_reviews', details: supabaseErrorToJson(insReviewErr) },
        { status: 400 }
      );
    }

    // subject_rollups を dirty に（後で集計・要約更新するため）
    {
      const { error: rollErr } = await supabaseAdmin
        .from('subject_rollups')
        .upsert(
          {
            subject_id: subjectId,
            is_dirty: true,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'subject_id' }
        );

      // ここは「投稿成功を優先」するなら try/catch で握ってもいいが、
      // まずは設計どおりに確実に立てる（失敗は検知したい）
      if (rollErr) {
        return NextResponse.json(
          { error: 'failed to upsert subject_rollups', details: supabaseErrorToJson(rollErr) },
          { status: 500 }
        );
      }
    }

    return NextResponse.json({ ok: true, review_id: inserted.id });
  } catch (e: any) {
    console.error('[course-reviews] POST error:', e);
    return NextResponse.json({ error: e?.message ?? 'server error' }, { status: 500 });
  }
}
