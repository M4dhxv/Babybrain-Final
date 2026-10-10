import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/admin';
import { createAdminClient } from '@/lib/supabase/admin';
import { notifyPromoted } from '@/lib/launch-event-notify';

/**
 * Send any "a spot opened up" emails that are still pending for this event - e.g. after a slot's
 * capacity was raised (which promotes in the database but isn't triggered by an admin click), or
 * after an earlier send failed (Resend down, key missing). Each parent is only ever emailed once.
 */
export const maxDuration = 60;

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { slug } = await params;
  if (!/^[a-z0-9-]{1,60}$/.test(slug)) return NextResponse.json({ error: 'No such event.' }, { status: 404 });

  const db = createAdminClient() as unknown as SupabaseClient;
  const result = await notifyPromoted(db, slug);
  if (result.disabled) return NextResponse.json({ ok: true, disabled: true, sent: 0 });
  if (result.error) return NextResponse.json({ error: result.error }, { status: 500 });
  return NextResponse.json({ ok: true, ...result });
}
