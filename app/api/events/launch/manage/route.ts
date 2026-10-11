import { NextResponse, after } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import { rateLimited, clientIp } from '@/lib/rate-limit';
import { logAdminAction } from '@/lib/admin-audit';
import { LAUNCH_EVENT_SLUG, normaliseSgPhone, parseRegistration } from '@/lib/launch-event';
import { verifyManageToken } from '@/lib/launch-event-manage';
import { emailRegistration, launchEmailsEnabled, notifyPromoted } from '@/lib/launch-event-notify';

/**
 * A registrant changing their own RSVP. Every call needs the signed token from /lookup (which proves
 * two of name / email / phone matched), and the token names exactly one registration.
 *
 *   { token, action: 'update',  ...same fields as the form }   edit the RSVP (slot, adults, children, contact)
 *   { token, action: 'contact', name, email, phone }           fix contact details only ("my email is incorrect")
 *   { token, action: 'cancel' }                                 cancel (revoke) the registration and free its seats
 *
 * A confirmed party never loses its place to an edit: if the new slot / size does not fit, the change is
 * refused and the registration stays as it was.
 */
type RegRow = { id: string; slot_key: string; name: string; email: string | null; phone: string; adult_names: string[]; child_details: { name: string; age: string }[] };

export async function POST(request: Request) {
  const db = createAdminClient() as unknown as SupabaseClient;
  if (await rateLimited(db, `launch-manage:${clientIp(request)}`, 30, 10 * 60)) {
    return NextResponse.json({ error: 'Too many attempts - please wait a few minutes and try again.' }, { status: 429 });
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const id = verifyManageToken(body?.token);
  if (!id) {
    return NextResponse.json({ error: 'This session has expired. Please enter your details again.', code: 'expired' }, { status: 401 });
  }
  const action = body?.action;

  const { data: current } = await db.from('event_registrations')
    .select('id, slot_key, name, email, phone, adult_names, child_details').eq('id', id).maybeSingle();
  const cur = current as RegRow | null;
  if (!cur) return NextResponse.json({ error: 'We could not find that registration - it may already have been cancelled.', code: 'gone' }, { status: 404 });

  // ---- cancel ----
  if (action === 'cancel') {
    const { data, error } = await db.rpc('cancel_event_registration', { p_id: id, p_actor: 'registrant' });
    if (error) {
      console.error('[launch-manage] cancel failed:', error.message);
      return NextResponse.json({ error: "We couldn't cancel just now. Please try again." }, { status: 500 });
    }
    const r = data as { ok: boolean; status?: string; slot_key?: string; party_size?: number; promoted?: { id: string; name: string; party_size: number }[] };
    if (!r.ok) return NextResponse.json({ error: 'That registration was already cancelled.', code: 'gone' }, { status: 404 });
    // the registration stays on record as cancelled (the admin sees it under Cancelled); the log itself holds no personal data
    await logAdminAction(db, { email: 'registrant', role: 'public' }, {
      action: 'event_registration.self_cancel',
      entityType: 'event_registration',
      entityId: id,
      summary: `A registrant cancelled their launch event registration (${r.status}, ${r.party_size} seats, slot ${r.slot_key})`,
      details: { promoted: (r.promoted ?? []).map((x) => x.id) },
    });
    after(() => notifyPromoted(db).catch(() => undefined));   // tells anyone promoted from the waitlist (if emails are on)
    return NextResponse.json({ ok: true, promoted: (r.promoted ?? []).length });
  }

  // ---- update / contact ----
  if (action !== 'update' && action !== 'contact') return NextResponse.json({ error: 'Unknown action.' }, { status: 400 });

  let fields: Record<string, unknown>;
  if (action === 'contact') {
    fields = {
      name: body?.name, email: body?.email, phone: body?.phone, slot: cur.slot_key,
      secondAdult: cur.adult_names[1] ?? '', children: cur.child_details, termsAccepted: true,
    };
  } else {
    fields = { ...(body as Record<string, unknown>), termsAccepted: true };   // they accepted the terms when they registered
  }
  const parsed = parseRegistration(fields, 'public');
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const v = parsed.value;
  const phone = normaliseSgPhone(v.phone) ?? v.phone;

  const { data, error } = await db.rpc('update_event_registration', {
    p_id: id, p_slot: v.slot, p_name: v.name, p_email: v.email, p_phone: phone,
    p_adult_names: v.adultNames, p_children: v.children, p_actor: 'registrant',
  });
  if (error) {
    const msg = error.message ?? '';
    if (msg.includes('unknown_slot')) return NextResponse.json({ error: 'Please pick a time.' }, { status: 400 });
    if (msg.includes('invalid_party')) return NextResponse.json({ error: 'Please check the adults and children.' }, { status: 400 });
    if (msg.includes('not_found')) return NextResponse.json({ error: 'We could not find that registration.', code: 'gone' }, { status: 404 });
    console.error('[launch-manage] update failed:', msg);
    return NextResponse.json({ error: "We couldn't save your changes just now. Please try again." }, { status: 500 });
  }
  const r = data as { ok: boolean; error?: string; status?: string; promoted?: { id: string; name: string; party_size: number }[] };
  if (!r.ok) {
    if (r.error === 'no_capacity') {
      return NextResponse.json({ error: "That time or party size isn't available right now. Your registration is unchanged.", code: 'no_capacity' }, { status: 409 });
    }
    if (r.error === 'email_taken') {
      return NextResponse.json({ error: 'That email address is already registered for this event.', code: 'email_taken' }, { status: 409 });
    }
    return NextResponse.json({ error: 'We could not save your changes.' }, { status: 400 });
  }

  await logAdminAction(db, { email: 'registrant', role: 'public' }, {
    action: 'event_registration.self_update',
    entityType: 'event_registration',
    entityId: id,
    summary: `A registrant updated their launch event registration (${action}${v.slot !== cur.slot_key ? `, moved slot ${cur.slot_key} -> ${v.slot}` : ''})`,
    details: { status: r.status, promoted: (r.promoted ?? []).map((x) => x.id) },
  });

  // If the email address changed, the confirmation goes to the new address. When emails are not switched
  // on (or the send fails) the admin gets an "email corrected" item so they can send it by hand.
  const emailChanged = (cur.email ?? '').toLowerCase() !== (v.email ?? '').toLowerCase();
  let emailSent = false;
  if (emailChanged) {
    if (launchEmailsEnabled()) emailSent = (await emailRegistration(db, id)).sent;
    if (!emailSent) {
      await db.from('event_issues').insert({
        event_slug: LAUNCH_EVENT_SLUG, registration_id: id, kind: 'email_corrected',
        name: v.name, email: v.email, phone, note: 'The registrant corrected their email address - send them the confirmation email.',
      });
    }
  }
  after(() => notifyPromoted(db).catch(() => undefined));
  return NextResponse.json({ ok: true, status: r.status, emailChanged, emailSent });
}
