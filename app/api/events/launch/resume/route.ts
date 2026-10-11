import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import { rateLimited, clientIp } from '@/lib/rate-limit';
import { LAUNCH_EVENT_SLUG } from '@/lib/launch-event';
import { verifyManageToken } from '@/lib/launch-event-manage';

/**
 * The "update the RSVP" link in the confirmation email: babybrain.sg/events?edit=<token>.
 *
 * The token was signed when the email was sent and names exactly one registration, so holding it
 * (it only ever went to the registrant's inbox) is the proof of ownership - the same answer the
 * form's own lookup gives when two details match. Returns what the page needs to open the edit form:
 *   { found: true, verified: true, token, status, slotLabel, registration }
 *   { found: false, cancelled?: true }    (cancelled, deleted, or another event)
 *   401 { code: 'expired' }               (forged, malformed or past its expiry)
 */
export async function POST(request: Request) {
  const db = createAdminClient() as unknown as SupabaseClient;
  if (await rateLimited(db, `launch-resume:${clientIp(request)}`, 30, 10 * 60)) {
    return NextResponse.json({ error: 'Too many attempts - please wait a few minutes and try again.' }, { status: 429 });
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const id = verifyManageToken(body?.token);
  if (!id) return NextResponse.json({ error: 'This link has expired.', code: 'expired' }, { status: 401 });

  const { data } = await db.from('event_registrations')
    .select('id, event_slug, status, slot_key, name, email, phone, adult_names, child_details')
    .eq('id', id).maybeSingle();
  const r = data as {
    id: string; event_slug: string; status: string; slot_key: string; name: string; email: string | null; phone: string;
    adult_names: string[] | null; child_details: { name: string; age: string }[] | null;
  } | null;
  if (!r || r.event_slug !== LAUNCH_EVENT_SLUG) return NextResponse.json({ found: false });
  if (r.status === 'cancelled') return NextResponse.json({ found: false, cancelled: true });

  const { data: slot } = await db.from('event_slots').select('label')
    .eq('event_slug', LAUNCH_EVENT_SLUG).eq('slot_key', r.slot_key).maybeSingle();

  return NextResponse.json({
    found: true, verified: true, status: r.status, token: body?.token,
    slotLabel: (slot as { label?: string } | null)?.label ?? null,
    registration: {
      name: r.name, email: r.email, phone: r.phone, slot: r.slot_key,
      secondAdult: (r.adult_names ?? [])[1] ?? '',
      children: r.child_details ?? [],
    },
  });
}
