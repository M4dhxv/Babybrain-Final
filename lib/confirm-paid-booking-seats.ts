import { createHash } from 'node:crypto';
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
  /** The confirm call itself failed (database unreachable or timed out), so
   *  nothing was settled. The caller must not report this checkout as handled:
   *  the webhook answers 500 so Stripe delivers it again. */
  failed?: boolean;
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
    return { confirmedIds: [], tokenIds: [], failed: true };
  }

  const confirmedIds = rows.filter((r) => r.confirmed).map((r) => r.id);
  const unseated = rows.filter((r) => !r.confirmed).map((r) => r.id);

  const tokenIds: string[] = [];
  for (const id of unseated) {
    if (await compensateUnseatedPaidSeat(admin, id, opts.paymentIntent)) tokenIds.push(id);
  }

  return { confirmedIds, tokenIds };
}

/**
 * One make-up token per booking, whoever gets here first. The webhook and
 * /api/stripe/reconcile settle the same checkout within moments of each other,
 * and "is there a token yet?" followed by an insert lets both insert. Deriving
 * the token's id from the booking makes the second insert a primary-key
 * conflict instead of a second token.
 */
function tokenIdFor(bookingId: string): string {
  const h = createHash('sha256').update(`unseated-paid-seat:${bookingId}`).digest('hex');
  const variant = ((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}

/**
 * Compensate a single seat this checkout charged but confirm_paid_booking_seats
 * could not seat. BabyBrain gives no cash refunds, only credits and make-up
 * tokens (founder, 29 Sep), so the payment becomes a make-up token for this
 * vendor instead of going back to the card. Two ways a seat ends up here:
 *
 *   - `waitlisted`: a "Pay now" claim that lost the race for the freed seat.
 *     The booking is deliberately NOT cancelled: the parent keeps their place
 *     on the waitlist, they just didn't win this particular seat.
 *   - `cancelled`: the booking was released for non-payment (an earlier
 *     checkout for it expired, or the 45-minute clean-up ran) while this
 *     checkout was still open, and the parent then paid. That used to take the
 *     money and leave nothing: no seat, no token, no ledger entry.
 *
 * Only a seat our books still show as unpaid qualifies. A seat that was paid
 * and confirmed and has since been completed or cancelled also comes back from
 * the RPC as "not confirmed" when the same checkout is settled again (Stripe
 * redelivering, or the parent reopening their confirmation link), and must not
 * be handed a token for it. Its payment_status is 'paid' (or 'refunded'), never
 * 'none': the RPC only sets 'paid' on seats it confirms.
 *
 * Idempotent on the booking. Never throws.
 */
async function compensateUnseatedPaidSeat(
  admin: Admin,
  bookingId: string,
  paymentIntent: string | null
): Promise<boolean> {
  try {
    const { data: booking } = await admin
      .from('bookings')
      .select('id, user_id, child_id, provider_id, session_id, amount, stripe_payment_intent, status, payment_status')
      .eq('id', bookingId)
      .maybeSingle();
    if (!booking || !booking.user_id || !booking.provider_id) return false;
    if (booking.payment_status !== 'none') return false;
    if (booking.status !== 'waitlisted' && booking.status !== 'cancelled') return false;
    if (Math.round(Number(booking.amount ?? 0) * 100) <= 0) return false;

    const { data: existing } = await admin
      .from('make_up_tokens')
      .select('id')
      .eq('origin_booking_id', bookingId)
      .limit(1)
      .maybeSingle();
    if (existing) return true;

    // The RPC stamps the payment intent on a waitlisted seat it could not
    // confirm, but leaves a cancelled one alone. Without it there is no record
    // of what paid for this token, so write it before issuing anything.
    const intent = booking.stripe_payment_intent ?? paymentIntent;
    if (!intent) return false;
    if (!booking.stripe_payment_intent) {
      await admin.from('bookings').update({ stripe_payment_intent: intent }).eq('id', bookingId);
    }

    // auto_issued: the manual-token trigger stays quiet; the notification
    // below explains what actually happened.
    const { data: token, error } = await admin
      .from('make_up_tokens')
      .insert({
        id: tokenIdFor(bookingId),
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
      // 23505: the other of webhook / reconcile issued it a moment ago.
      if (error?.code === '23505') return true;
      console.error('[compensateUnseatedPaidSeat] token insert failed for', bookingId, error?.message);
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
    const lostRace = booking.status === 'waitlisted';

    await admin.from('notifications').insert({
      user_id: booking.user_id,
      type: 'make_up_token_issued',
      title: 'Make-up token issued',
      body: lostRace
        ? `Someone else claimed the spot${activityName ? ` on ${activityName}` : ''} just before your payment went through. Your payment is now a make-up token${providerName ? ` for ${providerName}` : ''}, and you're still on the waitlist.`
        : `Your payment${activityName ? ` for ${activityName}` : ''} came through after your booking had been released. It is now a make-up token${providerName ? ` for ${providerName}` : ''}, ready to use on a class with them.`,
      data: {
        reason: lostRace ? 'waitlist_race' : 'paid_after_release',
        activity_name: activityName,
        provider_name: providerName,
        url: act?.slug ? `/book?slug=${act.slug}&token=${token.id}` : '/profile?tab=makeup',
        token_id: token.id,
        booking_id: bookingId,
      },
    });
    return true;
  } catch (e) {
    console.error('[compensateUnseatedPaidSeat] failed for', bookingId, e);
    return false;
  }
}
