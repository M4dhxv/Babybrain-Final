import { NextResponse } from 'next/server';
import { getAuthedContext } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * The signed-in parent's own booking history.
 *
 * The direct client-side query this replaces relied on RLS's "published
 * activities are public" policy, which has no exception for a parent looking
 * at their own past booking — so once a vendor removes/unpublishes an
 * activity, the nested activities/activity_sessions join silently came back
 * null and My Bookings fell back to a bare "Class" placeholder with no date.
 *
 * This route runs the equivalent of "select own bookings" (bookings.user_id
 * = the caller) through the service role instead, so the join isn't subject
 * to the activities/activity_sessions publish-gated policies at all.
 */
export async function GET(request: Request) {
  const { user } = await getAuthedContext(request);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const admin = createAdminClient();
  const { data, error } = await admin
    .from('bookings')
    .select(
      'id, status, created_at, child_id, guest_name, booking_group_id, package_purchase_id, payment_status, cancel_refund_mode, session_id, children(name), activity_sessions(starts_at, ends_at, activity_id, teacher_name, studio, provider_locations(name, address), activities(title, slug, image_urls, address, allow_cancellation, allow_rescheduling, cancellation_cutoff_hours, cancellation_refund_mode, reschedule_cutoff_hours, wix_removed_at, wix_missing_since, wix_service_type))'
    )
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  /* Most recently booked first, so a class the parent just booked is at the
     top of the list rather than buried under earlier-dated ones. Class start
     time is the tiebreak (later session first) for two bookings made at the
     same moment. Sorted here rather than in the query: activity_sessions is a
     to-one embed, and PostgREST's `referencedTable` ordering sorts the
     embedded rows, not the bookings that carry them. */
  const rows = (data ?? []).slice().sort((a, b) => {
    const c = String(b.created_at).localeCompare(String(a.created_at));
    if (c !== 0) return c;
    const at = (a as { activity_sessions?: { starts_at?: string } }).activity_sessions?.starts_at ?? '';
    const bt = (b as { activity_sessions?: { starts_at?: string } }).activity_sessions?.starts_at ?? '';
    return at < bt ? 1 : at > bt ? -1 : 0;
  });
  const allIds = rows.map((r) => r.id);

  // Was this booking made by redeeming a make-up token? (redeemed_booking_id
  // is cleared when such a booking is cancelled — 00081 — so this only ever
  // matches a live one.) And, for a cancelled booking, did an auto make-up
  // token get minted to compensate it? (00080)
  let redeemedByToken = new Set<string>();
  let autoCompensated = new Set<string>();
  if (allIds.length) {
    const [{ data: redeemed }, { data: minted }] = await Promise.all([
      admin.from('make_up_tokens').select('redeemed_booking_id').in('redeemed_booking_id', allIds),
      admin
        .from('make_up_tokens')
        .select('origin_booking_id')
        .in('origin_booking_id', allIds)
        .eq('auto_issued', true),
    ]);
    redeemedByToken = new Set(
      (redeemed ?? []).map((t) => t.redeemed_booking_id).filter((id): id is string => !!id)
    );
    autoCompensated = new Set(
      (minted ?? []).map((t) => t.origin_booking_id).filter((id): id is string => !!id)
    );
  }

  // Which of the caller's *waitlisted* bookings can be paid for right now to
  // claim a seat — a paid class, this booking still unsettled, the session
  // has a free seat, and it's near enough the front of the queue to be in
  // line for one. Fully derived, so it vanishes the instant the seat fills.
  const claimable = new Set<string>();
  const wlSessionIds = [
    ...new Set(rows.filter((r) => r.status === 'waitlisted').map((r) => r.session_id).filter(Boolean)),
  ] as string[];
  if (wlSessionIds.length) {
    const [{ data: sess }, { data: sessBookings }] = await Promise.all([
      admin
        .from('activity_sessions')
        .select('id, capacity, price, activities(price)')
        .in('id', wlSessionIds),
      admin
        .from('bookings')
        .select('id, session_id, status, payment_status, package_purchase_id, waitlist_position, created_at')
        .in('session_id', wlSessionIds),
    ]);
    const wlBookingIds = (sessBookings ?? [])
      .filter((b) => b.status === 'waitlisted')
      .map((b) => b.id);
    let redeemedWl = new Set<string>();
    if (wlBookingIds.length) {
      const { data: rt } = await admin
        .from('make_up_tokens')
        .select('redeemed_booking_id')
        .eq('status', 'redeemed')
        .in('redeemed_booking_id', wlBookingIds);
      redeemedWl = new Set((rt ?? []).map((t) => t.redeemed_booking_id).filter((id): id is string => !!id));
    }
    for (const s of sess ?? []) {
      const price = Number(s.price ?? (s.activities as { price?: number | null } | null)?.price ?? 0);
      if (price <= 0) continue; // free class: promotion is automatic
      const onSession = (sessBookings ?? []).filter((b) => b.session_id === s.id);
      const taken = onSession.filter((b) => b.status === 'confirmed' || b.status === 'pending').length;
      const free = s.capacity == null ? Number.POSITIVE_INFINITY : s.capacity - taken;
      if (free <= 0) continue;
      const queue = onSession
        .filter((b) => b.status === 'waitlisted')
        .sort(
          (a, b) =>
            (a.waitlist_position ?? 1e9) - (b.waitlist_position ?? 1e9) ||
            String(a.created_at).localeCompare(String(b.created_at))
        );
      for (let i = 0; i < Math.min(free, queue.length); i++) {
        const q = queue[i];
        const settled =
          q.payment_status === 'paid' || q.package_purchase_id != null || redeemedWl.has(q.id);
        if (!settled) claimable.add(q.id);
      }
    }
  }

  const bookings = rows.map((r) => {
    // The refund decision for this booking: what it was cancelled with, else
    // the class default, else the historical 'refund'. Drives both the
    // pre-cancel heads-up and the permanent line on a cancelled card.
    const refundMode: 'refund' | 'none' =
      (r.cancel_refund_mode as 'refund' | 'none' | null) ??
      ((r.activity_sessions?.activities?.cancellation_refund_mode as 'refund' | 'none' | undefined) ??
        'refund');
    return {
      ...r,
      // What paid for this booking — drives the cancel-confirm heads-up.
      paid_with: redeemedByToken.has(r.id)
        ? 'token'
        : r.package_purchase_id
          ? 'credit'
          : r.payment_status === 'paid'
            ? 'cash'
            : 'free',
      // What this class gives back on cancellation.
      refund_mode: refundMode,
      // A waitlisted booking with a seat waiting for it — show "Pay now".
      can_claim: claimable.has(r.id),
      // How a cancelled booking was made good (00080/00081) — the permanent
      // line on the card. 'none' when the provider withheld a refund, so the
      // card doesn't imply a credit came back off a lingering
      // package_purchase_id.
      compensation:
        r.status !== 'cancelled'
          ? null
          : refundMode === 'none'
            ? 'none'
            : autoCompensated.has(r.id)
              ? 'token'
              : r.package_purchase_id
                ? 'credit'
                : null,
    };
  });

  return NextResponse.json({ bookings });
}
