import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

/**
 * Refunds on the vendor earnings ledger.
 *
 * BabyBrain does not give cash refunds: a cancelled booking is made good with
 * a package credit or a make-up token, never money (founder, guide review
 * 28 Sep). The in-app cash refund (refundBooking and
 * /api/vendor/bookings/refund) was removed on 29 Sep, and a parent who loses a
 * waitlist seat race gets a make-up token instead
 * (lib/confirm-paid-booking-seats.ts).
 *
 * Money can still come back outside the app — a vendor refunding from their
 * own Stripe Express dashboard, or a chargeback — and the `charge.refunded` /
 * dispute webhooks record that here. Stripe's own processing fee is never
 * returned on a refund; the ledger keeps `stripe_fee_cents` for that reason.
 */

/**
 * Reflect a refund on the vendor's earnings ledger.
 *
 * Called from the `charge.refunded` and dispute webhooks, because a vendor can
 * refund straight from their own Stripe Express dashboard and a chargeback
 * takes money back regardless — the app itself never issues one.
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
    // Bookkeeping only — never fail a webhook over it.
  }
}
