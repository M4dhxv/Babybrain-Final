import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { getStripe } from '@/lib/stripe';

type Admin = SupabaseClient<Database>;

export interface ConfirmPaidSeatsResult {
  confirmedIds: string[];
  /** Charged but couldn't be seated because a concurrent claim on the same
   *  freed seat won the race — refunded here, left on the waitlist. */
  refundedIds: string[];
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
 * refunds whoever this checkout charged but couldn't seat, leaving them on
 * the waitlist rather than paid-but-not-queued or silently out of pocket.
 *
 * Callers: compute the provider_earnings ledger's gross from `confirmedIds`
 * only, not every seat this checkout charged — a refunded loser's money was
 * never really earned. This deliberately does NOT touch provider_earnings
 * itself (unlike lib/refunds.ts's refundBooking): that ledger's one row per
 * payment_intent covers every seat in the checkout, and marking it
 * "refunded" here would wrongly zero out the seats that stayed confirmed
 * when only one of several lost the race.
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
  if (ids.length === 0) return { confirmedIds: [], refundedIds: [] };

  const { data: rows, error } = await admin.rpc('confirm_paid_booking_seats', {
    p_seat_ids: ids,
    p_payment_intent: opts.paymentIntent,
  });
  if (error || !rows) {
    console.error('[confirmPaidBookingSeats] RPC failed:', error?.message ?? 'no rows returned');
    return { confirmedIds: [], refundedIds: [] };
  }

  const confirmedIds = rows.filter((r) => r.confirmed).map((r) => r.id);
  const losers = rows.filter((r) => !r.confirmed).map((r) => r.id);

  const refundedIds: string[] = [];
  for (const id of losers) {
    if (await refundLostWaitlistClaim(admin, id)) refundedIds.push(id);
  }

  return { confirmedIds, refundedIds };
}

/**
 * Refund a single seat that lost the capacity race in
 * confirm_paid_booking_seats — same split-aware refund logic as
 * lib/refunds.ts's refundBooking, but deliberately does NOT cancel the
 * booking: the parent still belongs on the waitlist, they just didn't win
 * this particular freed seat. Never throws — called from webhook/reconcile,
 * which must not fail over a refund hiccup.
 */
async function refundLostWaitlistClaim(admin: Admin, bookingId: string): Promise<boolean> {
  const { data: booking } = await admin
    .from('bookings')
    .select('id, amount, stripe_payment_intent, payment_status')
    .eq('id', bookingId)
    .maybeSingle();
  if (!booking || !booking.stripe_payment_intent || booking.payment_status === 'refunded') return false;

  const amountCents = Math.round(Number(booking.amount ?? 0) * 100);
  if (amountCents <= 0) return false;

  try {
    const stripe = getStripe();
    const intent = await stripe.paymentIntents.retrieve(booking.stripe_payment_intent, {
      expand: ['latest_charge'],
    });
    const charge = intent.latest_charge as { transfer?: unknown; application_fee_amount?: number | null } | null;
    await stripe.refunds.create({
      payment_intent: booking.stripe_payment_intent,
      amount: amountCents,
      ...(charge?.application_fee_amount ? { refund_application_fee: true } : {}),
      ...(charge?.transfer ? { reverse_transfer: true } : {}),
      metadata: { booking_id: bookingId, reason: 'lost_waitlist_claim_race' },
    });
  } catch (e) {
    console.error('[refundLostWaitlistClaim] Stripe refund failed for', bookingId, e);
    return false;
  }

  await admin.from('bookings').update({ payment_status: 'refunded' as const }).eq('id', bookingId);
  return true;
}
