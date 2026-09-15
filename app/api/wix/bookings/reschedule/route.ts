import { NextResponse } from 'next/server';
import { getAuthedContext } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { getProviderWixCredentials } from '@/lib/wix/client';
import { rescheduleWixClassBookingToSession } from '@/lib/wix/sync';

/**
 * Parent-facing reschedule for a Wix-linked CLASS booking. The plain
 * `reschedule_booking` Postgres RPC (supabase/migrations/00091) only ever
 * moves the local `bookings.session_id` — it's plpgsql with no HTTP
 * extension in use, so it structurally cannot tell Wix anything. That left
 * Wix's own calendar/availability stale after every reschedule: the old
 * occurrence never freed up, the new one never showed the seat as taken.
 * This route does the same validation the RPC does, then calls Wix's own
 * dedicated reschedule endpoint (rescheduleWixClassBookingToSession) before
 * touching the local row — a Wix-linked booking's own detail page still
 * calls this instead of the RPC directly; a non-Wix activity keeps using
 * the RPC unchanged.
 *
 * Scope: CLASS-type Wix services only (see rescheduleWixClassBooking's own
 * doc). A booking on a Wix APPOINTMENT or COURSE service — or a non-Wix
 * activity — is refused here; the caller should use the plain RPC for those
 * (unchanged, local-only, same as before this route existed).
 *
 * Body: { bookingId, newSessionId }. `bookingId` may be any one row of a
 * multi-seat party (00084) — every live seat shares one `wix_booking_id`,
 * so this moves the whole party in a single Wix call rather than once per
 * seat.
 */
export const maxDuration = 60;

export async function POST(request: Request) {
  const { booking_id, bookingId, new_session_id, newSessionId } = (await request.json().catch(() => ({}))) as {
    booking_id?: string; bookingId?: string; new_session_id?: string; newSessionId?: string;
  };
  const bkId = bookingId ?? booking_id;
  const newSessId = newSessionId ?? new_session_id;
  if (!bkId || !newSessId) {
    return NextResponse.json({ error: 'bookingId and newSessionId required' }, { status: 400 });
  }

  const { user } = await getAuthedContext(request);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const admin = createAdminClient();

  const { data: booking } = await admin
    .from('bookings')
    .select('id, user_id, session_id, status, booking_group_id, wix_booking_id')
    .eq('id', bkId)
    .maybeSingle();
  if (!booking || booking.user_id !== user.id) {
    return NextResponse.json({ error: 'Booking not found' }, { status: 404 });
  }
  if (!['pending', 'confirmed'].includes(booking.status)) {
    return NextResponse.json({ error: 'Only upcoming bookings can be rescheduled.' }, { status: 400 });
  }
  if (newSessId === booking.session_id) {
    return NextResponse.json({ error: 'That booking is already on this session — pick a different one.' }, { status: 400 });
  }

  // Every live seat of a party (00084) shares one wix_booking_id and moves
  // together — mirrors the frontend's own "a party moves every seat" rule,
  // just as one Wix call instead of N.
  const groupIds = booking.booking_group_id
    ? (
        await admin
          .from('bookings')
          .select('id')
          .eq('booking_group_id', booking.booking_group_id)
          .eq('user_id', user.id)
          .in('status', ['pending', 'confirmed'])
      ).data?.map((r) => r.id) ?? [booking.id]
    : [booking.id];
  const partySize = groupIds.length;

  const { data: oldSession } = await admin
    .from('activity_sessions')
    .select(
      'id, starts_at, activity_id, activities(id, provider_id, title, wix_service_id, wix_service_type, allow_rescheduling, reschedule_cutoff_hours)'
    )
    .eq('id', booking.session_id)
    .maybeSingle();
  const activity = oldSession?.activities as {
    id: string; provider_id: string; title: string; wix_service_id: string | null; wix_service_type: string | null;
    allow_rescheduling: boolean; reschedule_cutoff_hours: number;
  } | null;
  if (!oldSession || !activity) {
    return NextResponse.json({ error: 'Class not found' }, { status: 404 });
  }
  if (!activity.wix_service_id || activity.wix_service_type !== 'CLASS' || !booking.wix_booking_id) {
    return NextResponse.json(
      { error: 'This booking is not a Wix-linked class — use the standard reschedule instead.' },
      { status: 400 }
    );
  }
  if (!activity.allow_rescheduling) {
    return NextResponse.json({ error: 'The provider does not allow rescheduling for this class.' }, { status: 400 });
  }
  const oldCutoffMs = new Date(oldSession.starts_at).getTime() - activity.reschedule_cutoff_hours * 60 * 60 * 1000;
  if (oldCutoffMs < Date.now()) {
    return NextResponse.json(
      { error: `The rescheduling window for this class has closed (${activity.reschedule_cutoff_hours} hours before the session).` },
      { status: 400 }
    );
  }

  const { data: newSession } = await admin
    .from('activity_sessions')
    .select('id, activity_id, starts_at, capacity, bookings_paused, wix_slot_key, activities(bookings_paused)')
    .eq('id', newSessId)
    .maybeSingle();
  const newActivityPaused = (newSession?.activities as { bookings_paused: boolean } | null)?.bookings_paused;
  if (!newSession || newSession.activity_id !== activity.id) {
    return NextResponse.json({ error: 'You can only reschedule to another session of the same class.' }, { status: 400 });
  }
  if (new Date(newSession.starts_at).getTime() <= Date.now()) {
    return NextResponse.json({ error: 'That session has already started.' }, { status: 400 });
  }
  if (newActivityPaused) {
    return NextResponse.json({ error: 'Bookings for this class are currently paused.' }, { status: 400 });
  }
  if (newSession.bookings_paused) {
    return NextResponse.json(
      { error: 'Bookings for that session are currently paused — please pick another date.' },
      { status: 400 }
    );
  }
  if (newSession.capacity != null) {
    const { count } = await admin
      .from('bookings')
      .select('id', { count: 'exact', head: true })
      .eq('session_id', newSessId)
      .in('status', ['pending', 'confirmed']);
    if ((count ?? 0) + partySize > newSession.capacity) {
      return NextResponse.json({ error: 'That session is full.' }, { status: 400 });
    }
  }

  const creds = await getProviderWixCredentials(admin, activity.provider_id);
  if (!creds) {
    return NextResponse.json({ error: 'This business has not connected a Wix account' }, { status: 409 });
  }

  const result = await rescheduleWixClassBookingToSession(creds, activity.wix_service_id, booking.wix_booking_id, {
    wix_slot_key: newSession.wix_slot_key,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  const { error: updateError } = await admin.from('bookings').update({ session_id: newSessId }).in('id', groupIds);
  if (updateError) {
    console.error('Rescheduled in Wix but failed to save locally', booking.wix_booking_id, updateError);
    return NextResponse.json({ error: 'Moved in Wix but failed to save locally — contact support' }, { status: 500 });
  }

  // Matches reschedule_booking's own notification (00091) closely enough to
  // read the same way, without depending on session_email_details (a plain
  // SQL helper that RPC calls directly as SQL — not worth a second round
  // trip, and not in the generated RPC type union, here).
  const newWhen = new Date(newSession.starts_at).toLocaleString('en-SG', {
    timeZone: 'Asia/Singapore', weekday: 'short', day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
  });
  await admin.from('notifications').insert({
    user_id: user.id,
    type: 'booking_rescheduled',
    title: 'Booking moved',
    body: `Your booking for ${activity.title || 'a class'} is now on ${newWhen}.`,
    data: { url: '/profile?tab=bookings', booking_id: booking.id },
  });

  return NextResponse.json({ ok: true });
}
