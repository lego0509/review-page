export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

type Payload = {
  user_id: string; // users.id
};

function supabaseErrorToJson(err: any) {
  if (!err) return null;
  return {
    message: err.message,
    code: err.code,
    details: err.details,
    hint: err.hint,
  };
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Payload;

    if (!body?.user_id) {
      return NextResponse.json({ error: 'user_id is required' }, { status: 400 });
    }

    // 1) user_affiliations から最新所属（この設計では常に1行）を取得
    const { data: aff, error: affErr } = await supabaseAdmin
      .from('user_affiliations')
      .select('university_id, faculty, department')
      .eq('user_id', body.user_id)
      .maybeSingle();

    if (affErr) {
      return NextResponse.json(
        { error: 'failed to fetch user_affiliations', details: supabaseErrorToJson(affErr) },
        { status: 500 }
      );
    }

    // 所属が未登録なら空で返す（初回ユーザー）
    if (!aff) {
      return NextResponse.json({ ok: true, affiliation: null });
    }

    // 2) university_id から大学名を引く
    const { data: uni, error: uniErr } = await supabaseAdmin
      .from('universities')
      .select('name')
      .eq('id', aff.university_id)
      .maybeSingle();

    if (uniErr) {
      return NextResponse.json(
        { error: 'failed to fetch universities', details: supabaseErrorToJson(uniErr) },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      affiliation: {
        university_id: aff.university_id,
        university_name: uni?.name ?? '',
        faculty: aff.faculty ?? '',
        department: aff.department ?? '',
      },
    });
  } catch (e: any) {
    console.error('[user-affiliations/latest] POST error:', e);
    return NextResponse.json({ error: e?.message ?? 'server error' }, { status: 500 });
  }
}
