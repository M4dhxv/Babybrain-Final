import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

type Admin = SupabaseClient<Database>;

export interface ConfirmPaidSeatsResult {
  confirmedIds: string[];
  /** Charged but couldn't be seated because a concurrent claim on the same
   *  freed seat won the race. No cash refunds: the payment became a make-up
   *  token for the vendor and the seat stays on the waitlist. The money is
   *  kept, so these count toward the vendor's earnings like confirmed seats. */
  tokenIds: string[];
}

/**
 * Settle payment on one or more booking seats after a Stripe checkout for
 * `kind: 'booking'` completes.
 *
 * Called from both the webhook and /api/stripe/reconcile, which race each
 * other by design (reconcile is a safety net for a delayed webhook) and
 * used to each run a plain `UPDATE ... SET status = 'confirmed'` with no
 * lock or capacity re-check. That was fine for a `pending` seat (it already
 * reserved its place when it was created), but a `waitlisted` seat being
 * paid via "Pay now" reserved nothing — two parents invited to claim the
 * same freed seat could both pay and both get confirmed, a real overbook.
 * confirm_paid_booking_seats() (migration 00180) closes that under the same
 * session-row lock handle_booking_insert already uses; this wrapper then
 * gives whoever this checkout charged but couldn't seat a make-up token for
 * the vendor (no cash refunds), leaving them on the waitlist rather than
 * paid-but-not-queued or silently out of pocket.
 *
 * Callers: compute the provider_earnings ledger's gross from `confirmedIds`
 * plus `tokenIds`. The money for a token seat is kept (the token is redeemed
 * later as a class at the same vendor), so it was earned like a confirmed
 * seat. This deliberately does NOT touch provider_earnings itself: that
 * ledger's one row per payment_intent covers every seat in the checkout.
 */
export async function confirmPaidBookingSeats(
  admin: Admin,
  opts: {
    /** Preferred — the exact seats this checkout charged (always present on
     *  a session created after this fix; see app/api/bookings/checkout). */
    seatIds?: string[];
    /** Fallback for a session from before seat_ids was always stamped. */
    groupId?: string | null;
    bookingId?: string;
    paymentIntent: string | null;
    /** Reconcile scopes every read/write to the caller's own bookings; the
     *  webhook (no end-user request in flight) passes nothing. */
    scopeUserId?: string;
  }
): Promise<ConfirmPaidSeatsResult> {
  let ids = (opts.seatIds ?? []).filter(Boolean);
  if (ids.length === 0) {
    let q = admin.from('bookings').select('id');
    q = opts.groupId
      ? q.eq('booking_group_id', opts.groupId)
      : opts.bookingId
        ? q.eq('id', opts.bookingId)
        : q.eq('id', '00000000-0000-0000-0000-000000000000');
    if (opts.scopeUserId) q = q.eq('user_id', opts.scopeUserId);
    const { data } = await q;
    ids = (data ?? []).map((r) => r.id);
  }
  if (ids.length === 0) return { confirmedIds: [], tokenIds: [] };

  const { data: rows, error } = await admin.rpc('confirm_paid_booking_seats', {
    p_seat_ids: ids,
    p_payment_intent: opts.paymentIntent,
  });
  if (error || !rows) {
    console.error('[confirmPaidBookingSeats] RPC failed:', error?.message ?? 'no rows returned');
    return { confirmedIds: [], tokenIds: [] };
  }

  const confirmedIds = rows.filter((r) => r.confirmed).map((r) => r.id);
  const losers = rows.filter((r) => !r.confirmed).map((r) => r.id);

  const tokenIds: string[] = [];
  for (const id of losers) {
    if (await compensateLostWaitlistClaim(admin, id)) tokenIds.push(id);
  }

  return { confirmedIds, tokenIds };
}

/**
 * Compensate a single seat that lost the capacity race in
 * confirm_paid_booking_seats. BabyBrain gives no cash refunds, only credits
 * and make-up tokens (founder, 29 Sep), so the payment becomes a make-up token
 * for this vendor instead of going back to the card. It used to be refunded.
 *
 * The booking is deliberately NOT cancelled: the parent keeps their place on
 * the waitlist, they just didn't win this particular freed seat. Its
 * payment_status is never set to 'paid' (the RPC only does that for seats it
 * confirms), so it can't later be auto-confirmed as "already paid" on top of
 * the token.
 *
 * Idempotent on the booking: the webhook and /api/stripe/reconcile both run
 * this for the same checkout, and only the first issues a token. Never throws.
 */
async function compensateLostWaitlistClaim(admin: Admin, bookingId: string): Promise<boolean> {
  try {
    const { data: booking } = await admin
      .from('bookings')
      .select('id, user_id, child_id, provider_id, session_id, amount, stripe_payment_intent')
      .eq('id', bookingId)
      .maybeSingle();
    if (!booking || !booking.user_id || !booking.provider_id || !booking.stripe_payment_intent) return false;
    if (Math.round(Number(booking.amount ?? 0) * 100) <= 0) return false;

    const { data: existing } = await admin
      .from('make_up_tokens')
      .select('id')
      .eq('origin_booking_id', bookingId)
      .limit(1)
      .maybeSingle();
    if (existing) return true;

    // auto_issued: the manual-token trigger stays quiet; the email below
    // explains what actually happened.
    const { data: token, error } = await admin
      .from('make_up_tokens')
      .insert({
        provider_id: booking.provider_id,
        user_id: booking.user_id,
        child_id: booking.child_id,
        origin_booking_id: bookingId,
        status: 'issued',
        auto_issued: true,
      })
      .select('id')
      .single();
    if (error || !token) {
      console.error('[compensateLostWaitlistClaim] token insert failed for', bookingId, error?.message);
      return false;
    }

    const { data: session } = await admin
      .from('activity_sessions')
      .select('activities(title, slug, providers(business_name))')
      .eq('id', booking.session_id)
      .maybeSingle();
    const act = (session as { activities?: { title?: string; slug?: string; providers?: { business_name?: string } } } | null)?.activities;
    const activityName = act?.title ?? null;
    const providerName = act?.providers?.business_name ?? null;

    await admin.from('notifications').insert({
      user_id: booking.user_id,
      type: 'make_up_token_issued',
      title: 'Make-up token issued',
      body: `Someone else claimed the spot${activityName ? ` on ${activityName}` : ''} just before your payment went through. Your payment is now a make-up token${providerName ? ` for ${providerName}` : ''}, and you're still on the waitlist.`,
      data: {
        reason: 'waitlist_race',
        activity_name: activityName,
        provider_name: providerName,
        url: act?.slug ? `/book?slug=${act.slug}&token=${token.id}` : '/profile?tab=makeup',
        token_id: token.id,
        booking_id: bookingId,
      },
    });
    return true;
  } catch (e) {
    console.error('[compensateLostWaitlistClaim] failed for', bookingId, e);
    return false;
  }
}
