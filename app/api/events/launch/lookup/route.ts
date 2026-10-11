import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import { rateLimited, clientIp } from '@/lib/rate-limit';
import { LAUNCH_EVENT_SLUG, normaliseSgPhone } from '@/lib/launch-event';
import { OWNER_MATCHES_REQUIRED, maskEmail, maskName, maskPhone, signManageToken } from '@/lib/launch-event-manage';

/**
 * "Have I already registered?" - called when the form's first step is submitted.
 *
 * Takes the name / email / phone typed on the form and answers one of:
 *   { found: false }
 *   { found: true, verified: false, masked: {...} }   exactly one of email / phone matched:
 *       we say a registration exists (so the parent can fix it, or report a problem) but show it masked
 *       and allow no changes - anyone could type someone else's email.
 *   { found: true, verified: true, token, registration, ... }   two or more of name / email / phone matched:
 *       the registrant. Gets the full details to edit and a short-lived signed token for change / cancel.
 * Rate limited per IP because it answers "is this email registered".
 */
export async function POST(request: Request) {
  const db = createAdminClient() as unknown as SupabaseClient;
  if (await rateLimited(db, `launch-lookup:${clientIp(request)}`, 30, 10 * 60)) {
    return NextResponse.json({ error: 'Too many attempts - please wait a few minutes and try again.' }, { status: 429 });
  }

  const b = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const name = typeof b?.name === 'string' ? b.name.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
  const email = typeof b?.email === 'string' ? b.email.trim().toLowerCase().slice(0, 160) : '';
  const phone = normaliseSgPhone(b?.phone);
  if (!name || !email || !phone) return NextResponse.json({ error: 'Please check your name, email and number.' }, { status: 400 });

  const { data, error } = await db.rpc('find_event_registration', { p_event: LAUNCH_EVENT_SLUG, p_name: name, p_email: email, p_phone: phone });
  if (error) {
    console.error('[launch-lookup] rpc failed:', error.message);
    return NextResponse.json({ error: "We couldn't check just now. Please try again in a moment." }, { status: 500 });
  }
  const f = data as {
    found: boolean; id?: string; matched?: number; status?: string; slot_key?: string; name?: string; email?: string | null; phone?: string;
    adults?: number; children?: number; adult_names?: string[]; child_details?: { name: string; age: string }[];
  };
  if (!f.found || !f.id) return NextResponse.json({ found: false });

  const { data: slot } = await db.from('event_slots').select('label').eq('event_slug', LAUNCH_EVENT_SLUG).eq('slot_key', f.slot_key).maybeSingle();
  const slotLabel = (slot as { label?: string } | null)?.label ?? null;

  if ((f.matched ?? 0) < OWNER_MATCHES_REQUIRED) {
    return NextResponse.json({
      found: true, verified: false, slotLabel, status: f.status,
      masked: { name: maskName(f.name ?? ''), email: maskEmail(f.email ?? null), phone: maskPhone(f.phone ?? '') },
    });
  }

  return NextResponse.json({
    found: true, verified: true, slotLabel, status: f.status,
    token: signManageToken(f.id),
    registration: {
      name: f.name, email: f.email, phone: f.phone, slot: f.slot_key,
      secondAdult: (f.adult_names ?? [])[1] ?? '',
      children: f.child_details ?? [],
    },
  });
}
