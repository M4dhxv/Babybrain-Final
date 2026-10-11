import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import { rateLimited, clientIp } from '@/lib/rate-limit';
import { LAUNCH_EVENT_SLUG, normaliseSgPhone } from '@/lib/launch-event';
import { verifyManageToken } from '@/lib/launch-event-manage';

/**
 * "Report issue" (e.g. the confirmation email never arrived). Creates an item in the event's Issues
 * list in the admin portal. Works for someone who could not be verified too - that is exactly who
 * needs a human - so it takes either the signed token or the typed details, and stores what was typed.
 */
export async function POST(request: Request) {
  const db = createAdminClient() as unknown as SupabaseClient;
  if (await rateLimited(db, `launch-report:${clientIp(request)}`, 5, 10 * 60)) {
    return NextResponse.json({ error: 'You have already reported this - our team will be in touch.' }, { status: 429 });
  }
  const b = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
  const note = str(b?.note, 500);
  const registrationId = verifyManageToken(b?.token);

  let name = str(b?.name, 80);
  let email = str(b?.email, 160).toLowerCase();
  let phone = normaliseSgPhone(b?.phone) ?? '';
  if (registrationId) {
    const { data } = await db.from('event_registrations').select('name, email, phone').eq('id', registrationId).maybeSingle();
    const r = data as { name: string; email: string | null; phone: string } | null;
    if (r) { name = r.name; email = r.email ?? ''; phone = r.phone; }
  }
  if (!name && !email && !phone) return NextResponse.json({ error: 'Please tell us who you are.' }, { status: 400 });

  // an identical open report is not duplicated
  const { data: dup } = await db.from('event_issues').select('id')
    .eq('event_slug', LAUNCH_EVENT_SLUG).eq('kind', 'report').eq('status', 'open').eq('email', email).eq('phone', phone).limit(1);
  if (!dup || dup.length === 0) {
    const { error } = await db.from('event_issues').insert({
      event_slug: LAUNCH_EVENT_SLUG, registration_id: registrationId, kind: 'report',
      name: name || null, email: email || null, phone: phone || null,
      note: note || 'The registrant says they did not receive their confirmation email.',
    });
    if (error) {
      console.error('[launch-report] insert failed:', error.message);
      return NextResponse.json({ error: "We couldn't send your report just now. Please email hello@babybrain.sg." }, { status: 500 });
    }
  }
  return NextResponse.json({ ok: true });
}
