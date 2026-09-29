import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireProviderRole } from '@/lib/vendor';
import { getProviderWixCredentials } from '@/lib/wix/client';
import { cancelWixLinkedBooking } from '@/lib/wix/sync';

/**
 * Vendor adds a booking taken outside BabyBrain (phone, walk-in). It is stored
 * on BabyBrain only — for a Wix-linked activity too: nothing is written to
 * Wix, so it does not appear in the vendor's Wix calendar and does not change
 * Wix's seat count or the parent-facing "spots left" from Wix. The response's
 * `wix_linked` lets the portal say so.
 * Body: { provider_id, session_id, name, contact?, paid?, increase_capacity? }
 *
 * `increase_capacity` is for a FULL native session: raises its capacity by one
 * and books the guest into that seat atomically, without offering the seat to
 * the waitlist (add_manual_booking_over_capacity, migration 00196). Wix-linked
 * sessions refuse it — Wix owns their capacity.
 *
 * (Entries created before this rule may carry a wix_booking_id from when a
 * class booking was also created in Wix; DELETE below still frees that seat.)
 */
export const maxDuration = 60;

const AT_CAPACITY_MESSAGE =
  'This activity is at capacity. If you wish to add a booking, please increase the capacity.';

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    provider_id?: string; session_id?: string; name?: string; contact?: string; paid?: boolean;
    increase_capacity?: boolean;
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
    .select('id, activity_id, wix_slot_key, capacity')
    .eq('id', body.session_id)
    .maybeSingle();
  const { data: activity } = session
    ? await admin
        .from('activities')
        .select('id, provider_id, wix_service_id, wix_service_type, wix_event_id')
        .eq('id', session.activity_id)
        .maybeSingle()
    : { data: null };
  if (!session || !activity || activity.provider_id !== body.provider_id) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  if (body.increase_capacity) {
    if (session.wix_slot_key || activity.wix_service_id || activity.wix_service_type || activity.wix_event_id) {
      return NextResponse.json(
        { error: "This slot's capacity is managed on Wix, so it can't be increased here. Raise it in Wix instead." },
        { status: 400 }
      );
    }
    const { data: result, error: rpcError } = await admin.rpc('add_manual_booking_over_capacity', {
      p_session_id: session.id,
      p_name: name,
      p_contact: body.contact?.trim() || null,
      p_paid: !!body.paid,
    });
    if (rpcError || !result) {
      console.error('Manual booking over-capacity failed', rpcError);
      return NextResponse.json({ error: rpcError?.message ?? 'Could not save the booking' }, { status: 500 });
    }
    return NextResponse.json({ ...result, wix_linked: false, synced_to_wix: false });
  }

  // A full session can't take a manual booking (the insert would be turned into
  // a waitlist row the vendor never asked for, and surfaced a raw RLS error).
  // Wix-linked sessions are checked by Wix itself below.
  if (!session.wix_slot_key && session.capacity != null) {
    const { count } = await admin
      .from('bookings')
      .select('id', { count: 'exact', head: true })
      .eq('session_id', session.id)
      .in('status', ['pending', 'confirmed', 'completed']);
    if ((count ?? 0) >= session.capacity) {
      return NextResponse.json({ error: AT_CAPACITY_MESSAGE }, { status: 409 });
    }
  }

  const contact = body.contact?.trim() || null;

  // Manual bookings are recorded on BabyBrain ONLY — never written to Wix, for
  // any Wix-linked activity (class, course, appointment or event). They used to
  // be created in Wix first for a class, but Events have no service/slot to
  // book against, so the behaviour differed by type and a vendor saw an
  // unsynced entry with no warning. One rule now: the entry lives here, and for
  // a Wix-linked activity the vendor is told it won't appear in Wix or change
  // Wix's seat count (`wix_linked` drives that notice in the portal).
  const wixLinked = !!(activity.wix_service_id || activity.wix_service_type || activity.wix_event_id);

  const { data: row, error } = await admin
    .from('bookings')
    .insert({
      session_id: session.id,
      guest_name: name,
      guest_contact: contact,
      payment_status: body.paid ? 'paid' : 'none',
      status: 'confirmed',
      // Manual rows have no parent account; the generated types predate that.
    } as never)
    .select('id, status')
    .single();
  if (error || !row) {
    console.error('Manual booking local insert failed', error);
    return NextResponse.json({ error: error?.message ?? 'Could not save the booking' }, { status: 500 });
  }
  // The capacity check above isn't atomic with this insert. If two entries race
  // for the last seat, handle_booking_insert (00156) serializes them on the
  // session row and turns the loser into a waitlist row. A vendor adding a
  // booking never asked for that — undo it and report the same "at capacity".
  if (row.status === 'waitlisted') {
    const { error: undoError } = await admin.from('bookings').delete().eq('id', row.id);
    if (undoError) console.error('Manual booking waitlist rollback failed', undoError);
    return NextResponse.json({ error: AT_CAPACITY_MESSAGE }, { status: 409 });
  }
  return NextResponse.json({ id: row.id, status: row.status, wix_linked: wixLinked, synced_to_wix: false });
}

/**
 * Deleting a manual entry also frees its seat on Wix — but only for a legacy
 * entry that was created in Wix (has a wix_booking_id); entries stored on
 * BabyBrain only have nothing to free. Only manual rows (no user_id) are
 * deletable, same rule as the RLS policy from 00091.
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
