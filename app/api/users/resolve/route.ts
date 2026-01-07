export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { createHmac } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

type Payload = {
  line_user_id: string;
};

function lineUserIdToHash(lineUserId: string) {
  const pepper = process.env.LINE_HASH_PEPPER;
  if (!pepper) throw new Error('LINE_HASH_PEPPER is not set');
  return createHmac('sha256', pepper).update(lineUserId, 'utf8').digest('hex');
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

/**
 * users を line_user_hash で upsert して users.id を返す
 * - 画面表示用（デバッグ/照合用）
 * - 生のline_user_idはDB保存しない
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

  // UNIQUE競合（同時アクセス）なら再検索
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

    if (!body?.line_user_id) {
      return NextResponse.json({ error: 'line_user_id is required' }, { status: 400 });
    }

    const userId = await getOrCreateUserId(body.line_user_id);

    return NextResponse.json({ ok: true, user_id: userId });
  } catch (e: any) {
    console.error('[users/resolve] POST error:', e);
    return NextResponse.json(
      { error: e?.message ?? 'server error', details: supabaseErrorToJson(e) },
      { status: 500 }
    );
  }
}
