import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getStripe } from '@/lib/stripe';
import type { Database } from '@/types/database';

/**
 * Refunding a booking that was split to a vendor.
 *
 * Bookings are destination charges: the parent paid BabyBrain, BabyBrain kept
 * an application fee and transferred the rest to the vendor. A naive
 * `refunds.create` gives the parent their money back out of BabyBrain's
 * balance and leaves the vendor holding their share — BabyBrain eats the whole
 * refund plus the Stripe fee, which is never recovered.
 *
 * So a refund here always unwinds the split:
 *   reverse_transfer      → pulls the vendor's share back
 *   refund_application_fee→ returns BabyBrain's commission
 * Both are proportional on a partial refund, so a 50% refund claws back 50%
 * of the transfer and 50% of the fee.
 *
 * Stripe's own processing fee is NOT returned on a refund. That cost lands on
 * whoever the vendor's terms say absorbs it, which is recorded on the earnings
 * row — the ledger keeps `stripe_fee_cents` after a refund for exactly this
 * reason.
 *
 * Both flags must be set conditionally, not always: on a charge that was never
 * split (a vendor who hasn't finished Connect onboarding — currently all of
 * them) Stripe rejects the refund outright with "Cannot reverse transfer on
 * charge ... because it does not have an associated transfer".
 */

export interface RefundResult {
  ok: boolean;
  refundId?: string;
  amountCents?: number;
  error?: string;
}

/**
 * Refund a paid booking, in full or in part.
 *
 * `amountCents` omitted refunds everything. Idempotent enough for UI use: a
 * booking already fully refunded returns ok with no new refund rather than
 * refunding twice.
 */
export async function refundBooking(
  admin: SupabaseClient<Database>,
  bookingId: string,
  amountCents?: number
): Promise<RefundResult> {
  const { data: booking } = await admin
    .from('bookings')
    .select('id, amount, payment_status, stripe_payment_intent')
    .eq('id', bookingId)
    .maybeSingle();

  if (!booking) return { ok: false, error: 'Booking not found' };
  if (booking.payment_status === 'refunded') {
    return { ok: true, error: undefined, amountCents: 0 };
  }
  if (booking.payment_status !== 'paid' || !booking.stripe_payment_intent) {
    return { ok: false, error: 'This booking was never paid, so there is nothing to refund.' };
  }

  const paidCents = Math.round(Number(booking.amount ?? 0) * 100);
  if (amountCents !== undefined && (amountCents <= 0 || amountCents > paidCents)) {
    return { ok: false, error: 'Refund amount must be between 1 cent and what the parent paid.' };
  }

  const stripe = getStripe();

  // Ask Stripe what this charge actually looks like before deciding how to
  // unwind it — a charge with no transfer/application fee rejects those flags.
  let hasTransfer = false;
  let hasApplicationFee = false;
  try {
    const intent = await stripe.paymentIntents.retrieve(booking.stripe_payment_intent, {
      expand: ['latest_charge'],
    });
    const charge = intent.latest_charge as Stripe.Charge | null;
    hasTransfer = Boolean(charge?.transfer);
    hasApplicationFee = Boolean(charge?.application_fee_amount);
  } catch {
    // Fall through with both false: a plain refund always works, and it's
    // better to return the parent's money than to block on bookkeeping.
  }

  let refund: Stripe.Refund;
  try {
    refund = await stripe.refunds.create({
      payment_intent: booking.stripe_payment_intent,
      ...(amountCents !== undefined ? { amount: amountCents } : {}),
      // Proportional on a partial refund: half a refund claws back half the
      // transfer and half the fee.
      ...(hasApplicationFee ? { refund_application_fee: true } : {}),
      ...(hasTransfer ? { reverse_transfer: true } : {}),
      metadata: { booking_id: bookingId },
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Stripe refused the refund.' };
  }

  const full = (amountCents ?? paidCents) >= paidCents;
  await admin
    .from('bookings')
    .update({
      // A partial refund leaves the booking paid — the parent still holds a
      // place they part-paid for. Only a full refund unwinds it.
      ...(full ? { payment_status: 'refunded' as const, status: 'cancelled' as const } : {}),
    })
    .eq('id', bookingId);

  await markEarningRefunded(admin, booking.stripe_payment_intent, full);

  return { ok: true, refundId: refund.id, amountCents: refund.amount };
}

/**
 * Reflect a refund on the vendor's earnings ledger.
 *
 * Called both from {@link refundBooking} and from the `charge.refunded`
 * webhook, because a vendor can also refund straight from their own Stripe
 * Express dashboard — in which case this is the only path that runs.
 */
export async function markEarningRefunded(
  admin: SupabaseClient<Database>,
  paymentIntentId: string,
  full: boolean
): Promise<void> {
  try {
    // A partial refund leaves the sale standing; the ledger keeps reporting it
    // as earned, minus nothing. Only a full refund zeroes it out.
    if (!full) return;
    await admin
      .from('provider_earnings')
      .update({ status: 'refunded' })
      .eq('stripe_payment_intent', paymentIntentId);
  } catch {
    // Bookkeeping only — never fail a refund over it.
  }
}
