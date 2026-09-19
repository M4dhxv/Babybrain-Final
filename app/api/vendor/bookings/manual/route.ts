import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireProviderRole } from '@/lib/vendor';
import { getProviderWixCredentials, encodeWixSlotKey, decodeWixSlotKey, fetchWixClassSessions } from '@/lib/wix/client';
import { createWixBookingAndSession, cancelWixLinkedBooking } from '@/lib/wix/sync';

/**
 * Vendor adds a booking taken outside BabyBrain (phone, walk-in). For a
 * Wix-linked class it is created in Wix FIRST — Wix owns the seat count, and
 * the parent-facing availability (/api/wix/slots) reads Wix's remaining
 * capacity — then mirrored locally with the wix_booking_id, so the roster,
 * Wix's calendar and the parent's "spots left" all agree. Non-Wix activities
 * just get the local row. If the local insert fails after Wix accepted, the
 * Wix booking is cancelled again so no orphan seat is left behind.
 * Body: { provider_id, session_id, name, contact?, paid? }
 */
export const maxDuration = 60;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    provider_id?: string; session_id?: string; name?: string; contact?: string; paid?: boolean;
  };
  const name = body.name?.trim();
  if (!body.provider_id || !body.session_id || !name) {
    return NextResponse.json({ error: 'provider_id, session_id and a name are required' }, { status: 400 });
  }
  const auth = await requireProviderRole(request, body.provider_id, 'manager');
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const admin = createAdminClient();
  const { data: session } = await admin
    .from('activity_sessions')
    .select('id, activity_id, wix_slot_key')
    .eq('id', body.session_id)
    .maybeSingle();
  const { data: activity } = session
    ? await admin
        .from('activities')
        .select('id, provider_id, wix_service_id, wix_resource_id, wix_service_type')
        .eq('id', session.activity_id)
        .maybeSingle()
    : { data: null };
  if (!session || !activity || activity.provider_id !== body.provider_id) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  const contact = body.contact?.trim() || null;
  let sessionId = session.id;
  let wixBookingId: string | null = null;
  let creds = null as Awaited<ReturnType<typeof getProviderWixCredentials>>;

  if (activity.wix_service_id && session.wix_slot_key) {
    creds = await getProviderWixCredentials(admin, body.provider_id);
    if (!creds) {
      return NextResponse.json({ error: 'This business has not connected a Wix account' }, { status: 409 });
    }
    let slotKey = session.wix_slot_key;
    try {
      // A COURSE anchor row ('wixcourse:<scheduleId>') isn't a resolvable
      // slot — pick any live occurrence of that schedule; the Wix call books
      // the whole schedule anyway.
      if (slotKey.startsWith('wixcourse:')) {
        const scheduleId = slotKey.slice('wixcourse:'.length);
        const live = await fetchWixClassSessions(creds, activity.wix_service_id, 60);
        const occ = live.find((s) => s.scheduleId === scheduleId);
        if (!occ) {
          return NextResponse.json({ error: 'That course has no open dates left on Wix.' }, { status: 409 });
        }
        slotKey = encodeWixSlotKey({ kind: 'class', sessionId: occ.id });
      } else {
        decodeWixSlotKey(slotKey); // throws on a key we can't book against
      }
    } catch {
      return NextResponse.json({ error: 'This session can\'t be booked through Wix.' }, { status: 409 });
    }

    const [first, ...rest] = name.split(/\s+/);
    const isEmail = !!contact && contact.includes('@');
    const result = await createWixBookingAndSession(
      admin,
      creds,
      { id: activity.id, wix_service_id: activity.wix_service_id, wix_resource_id: activity.wix_resource_id, wix_service_type: activity.wix_service_type },
      `wix:${slotKey}`,
      { firstName: first || 'Guest', lastName: rest.join(' ') || '-', email: isEmail ? contact! : '', phone: contact && !isEmail ? contact : '' },
      1,
      null, // vendors may book inside the parent cut-off window
    );
    if (!result.ok) {
      const msg = result.status === 409 && /no longer available|Not enough/i.test(result.error)
        ? 'Wix shows this session as full — increase its capacity on Wix first.'
        : result.error;
      return NextResponse.json({ error: msg }, { status: result.status });
    }
    sessionId = result.sessionId;
    wixBookingId = result.wixBookingId;
  }

  const { data: row, error } = await admin
    .from('bookings')
    .insert({
      session_id: sessionId,
      guest_name: name,
      guest_contact: contact,
      payment_status: body.paid ? 'paid' : 'none',
      status: 'confirmed',
      wix_booking_id: wixBookingId,
      // Manual rows have no parent account; the generated types predate that.
    } as never)
    .select('id, status')
    .single();
  if (error || !row) {
    console.error('Manual booking local insert failed', error);
    if (wixBookingId && creds) {
      const undo = await cancelWixLinkedBooking(creds, wixBookingId);
      if (!undo.ok) console.error('ORPHAN Wix booking after failed manual insert', wixBookingId);
    }
    return NextResponse.json({ error: error?.message ?? 'Could not save the booking' }, { status: 500 });
  }
  return NextResponse.json({ id: row.id, status: row.status, synced_to_wix: !!wixBookingId });
}

/**
 * Deleting a manual entry also frees its seat on Wix. Only manual rows
 * (no user_id) are deletable, same rule as the RLS policy from 00091.
 * Query: ?provider_id=&booking_id=
 */
export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const providerId = searchParams.get('provider_id');
  const bookingId = searchParams.get('booking_id');
  if (!providerId || !bookingId) {
    return NextResponse.json({ error: 'provider_id and booking_id required' }, { status: 400 });
  }
  const auth = await requireProviderRole(request, providerId, 'manager');
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const admin = createAdminClient();
  const { data: b } = await admin
    .from('bookings')
    .select('id, user_id, guest_name, wix_booking_id, provider_id')
    .eq('id', bookingId)
    .maybeSingle();
  if (!b || b.provider_id !== providerId || b.user_id !== null || !b.guest_name) {
    return NextResponse.json({ error: 'Only manually-added bookings can be deleted.' }, { status: 403 });
  }
  if (b.wix_booking_id) {
    const creds = await getProviderWixCredentials(admin, providerId);
    if (creds) {
      const res = await cancelWixLinkedBooking(creds, b.wix_booking_id);
      if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
    }
  }
  const { error } = await admin.from('bookings').delete().eq('id', bookingId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
