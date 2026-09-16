import { NextResponse } from 'next/server';
import { getAuthedContext } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { getProviderWixCredentials } from '@/lib/wix/client';
import { cancelWixLinkedBooking } from '@/lib/wix/sync';
import type { BookingStatus } from '@/types/database';

/**
 * Parent-facing cancellation for a whole booking or a whole party
 * (00084) — replaces calling `cancel_booking`/`cancel_booking_group`
 * directly for any booking whose activity is Wix-linked, so Wix's own
 * calendar/availability actually frees the seat up instead of going stale
 * (those RPCs, supabase/migrations/00099, only ever flip the local
 * `bookings.status` — plpgsql, no HTTP extension, so they structurally
 * cannot tell Wix anything).
 *
 * Does the same validation the RPCs do, then — only when the activity is
 * Wix-linked — calls Wix's cancel endpoint before touching the local rows.
 * For a non-Wix activity this route is equivalent to the RPCs (no Wix call
 * made) and safe to use as their drop-in replacement.
 *
 * Deliberately NOT used for `cancelPlace` (cancelling one seat of a party
 * while the rest stay booked): every seat of a party shares one Wix
 * booking, and Wix has no "reduce participant count" operation — cancelling
 * the shared wix_booking_id there would wrongly cancel the siblings who are
 * still attending. That stays on the plain `cancel_booking` RPC
 * (local-only) — a known, separate gap, not fixed here.
 *
 * Notifications and make-up-token/credit compensation are unchanged: both
 * already run off a trigger on `bookings` (notify_booking_cancelled and the
 * compensation trigger, 00080/00099) that fires on the UPDATE itself, not on
 * which code path performed it.
 *
 * Body: { bookingId } for a single booking, or { groupId } for a whole
 * party.
 */
export const maxDuration = 60;

export async function POST(request: Request) {
  const { booking_id, bookingId, group_id, groupId } = (await request.json().catch(() => ({}))) as {
    booking_id?: string; bookingId?: string; group_id?: string; groupId?: string;
  };
  const bkId = bookingId ?? booking_id;
  const grpId = groupId ?? group_id;
  if (!bkId && !grpId) {
    return NextResponse.json({ error: 'bookingId or groupId required' }, { status: 400 });
  }

  const { user } = await getAuthedContext(request);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const admin = createAdminClient();
  const LIVE: BookingStatus[] = ['pending', 'confirmed', 'waitlisted'];

  const rowsQuery = admin
    .from('bookings')
    .select('id, user_id, session_id, status, wix_booking_id, booking_group_id')
    .eq('user_id', user.id)
    .in('status', LIVE);
  const { data: rows } = grpId ? await rowsQuery.eq('booking_group_id', grpId) : await rowsQuery.eq('id', bkId!);
  if (!rows || rows.length === 0) {
    return NextResponse.json({ error: 'This booking can no longer be cancelled.' }, { status: 400 });
  }
  // A single bookingId that turns out to belong to a party (rather than the
  // caller passing groupId) is refused rather than silently cancelling just
  // that one seat's Wix booking — every seat of a party shares one Wix
  // booking, so cancelling it here would wrongly take the siblings' seats
  // down too while their local rows stayed 'confirmed'. Cancelling a single
  // seat of a party while the rest stay booked isn't supported here at all
  // (see this file's own doc) — that's still the plain RPC, local-only.
  if (!grpId && rows[0].booking_group_id) {
    return NextResponse.json({ error: 'Pass groupId to cancel every seat of this booking together.' }, { status: 400 });
  }

  const sessionId = rows[0].session_id;
  const { data: session } = await admin
    .from('activity_sessions')
    .select(
      'starts_at, allow_cancellation, cancellation_cutoff_hours, cancellation_refund_mode, activities(provider_id, allow_cancellation, cancellation_cutoff_hours, cancellation_refund_mode, wix_service_id)'
    )
    .eq('id', sessionId)
    .maybeSingle();
  const activity = session?.activities as {
    provider_id: string; allow_cancellation: boolean; cancellation_cutoff_hours: number;
    cancellation_refund_mode: 'refund' | 'none' | null; wix_service_id: string | null;
  } | null;
  if (!session || !activity) {
    return NextResponse.json({ error: 'Class not found' }, { status: 404 });
  }
  // A session-level override (migration 00133) wins over the activity's
  // default; null on the session means "inherit".
  const allowCancellation = session.allow_cancellation ?? activity.allow_cancellation;
  const cancellationCutoffHours = session.cancellation_cutoff_hours ?? activity.cancellation_cutoff_hours;
  const cancellationRefundMode = session.cancellation_refund_mode ?? activity.cancellation_refund_mode;
  if (!allowCancellation) {
    return NextResponse.json({ error: 'The provider does not allow cancellations for this class.' }, { status: 400 });
  }
  const cutoffMs = new Date(session.starts_at).getTime() - cancellationCutoffHours * 60 * 60 * 1000;
  if (cutoffMs < Date.now()) {
    return NextResponse.json(
      { error: `The cancellation window for this class has closed (${cancellationCutoffHours} hours before the session).` },
      { status: 400 }
    );
  }

  // Every live seat of a party shares one wix_booking_id — cancel it once,
  // not once per row.
  const wixBookingId = rows.find((r) => r.wix_booking_id)?.wix_booking_id ?? null;
  if (activity.wix_service_id && wixBookingId) {
    const creds = await getProviderWixCredentials(admin, activity.provider_id);
    if (!creds) {
      return NextResponse.json({ error: 'This business has not connected a Wix account' }, { status: 409 });
    }
    const result = await cancelWixLinkedBooking(creds, wixBookingId);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
  }

  const mode = cancellationRefundMode || 'refund';
  const { error } = await admin
    .from('bookings')
    .update({ status: 'cancelled', cancel_refund_mode: mode })
    .in('id', rows.map((r) => r.id));
  if (error) {
    console.error('Cancelled in Wix but failed to save locally', wixBookingId, error);
    return NextResponse.json({ error: 'Cancelled in Wix but failed to save locally — contact support' }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
