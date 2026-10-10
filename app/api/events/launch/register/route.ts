import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import { rateLimited, clientIp } from '@/lib/rate-limit';
import { LAUNCH_EVENT_SLUG, parseRegistration, type RegisterResult } from '@/lib/launch-event';

/**
 * Public registration for the BabyBrain launch event (babybrain.sg/events).
 *
 * Open to signed-out visitors, so it is rate limited per IP and does nothing but call the
 * register_for_event database function (migration 00231), which decides in one atomic step
 * whether the whole party is confirmed or goes on the waitlist (50 seats per slot).
 * The browser is only ever told confirmed / waitlisted - never seat counts.
 */
export async function POST(request: Request) {
  const db = createAdminClient() as unknown as SupabaseClient;

  // 20 attempts per IP per 10 minutes: plenty for a family retrying, tight for a script.
  if (await rateLimited(db, `launch-register:${clientIp(request)}`, 20, 10 * 60)) {
    return NextResponse.json({ error: 'Too many attempts - please wait a few minutes and try again.' }, { status: 429 });
  }

  const body = await request.json().catch(() => null);
  const parsed = parseRegistration(body, 'public');
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const v = parsed.value;

  const { data, error } = await db.rpc('register_for_event', {
    p_event: LAUNCH_EVENT_SLUG,
    p_slot: v.slot,
    p_name: v.name,
    p_email: v.email,
    p_phone: v.phone,
    p_adult_names: v.adultNames,
    p_children: v.children,
    p_source: 'web',
  });

  if (error) {
    const msg = error.message ?? '';
    if (msg.includes('unknown_slot')) return NextResponse.json({ error: 'Please pick a time.' }, { status: 400 });
    if (msg.includes('invalid_party')) return NextResponse.json({ error: 'Please check the adults and children.' }, { status: 400 });
    console.error('[launch-register] rpc failed:', msg);
    return NextResponse.json({ error: "We couldn't save your registration just now. Please try again in a moment." }, { status: 500 });
  }

  const r = data as RegisterResult;
  return NextResponse.json({ status: r.status, duplicate: r.duplicate });
}
