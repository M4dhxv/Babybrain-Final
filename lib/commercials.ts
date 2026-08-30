import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getStripe } from '@/lib/stripe';
import type { Database } from '@/types/database';

/**
 * BabyBrain's commercial terms with a vendor, and the arithmetic that turns
 * them into a Stripe application fee.
 *
 * Terms live on the provider's `subscriptions` row so they can be negotiated
 * per vendor. Every sale stamps the terms it was priced under onto
 * `provider_earnings`, so changing a rate never rewrites history.
 */

export type FeePayer = 'platform' | 'vendor';

export interface Terms {
  commissionRate: number;
  commissionFlatCents: number;
  feePayer: FeePayer;
  commissionOnPackages: boolean;
}

/** Used when a provider has no subscriptions row at all. */
export const DEFAULT_TERMS: Terms = {
  commissionRate: 0.15,
  commissionFlatCents: 0,
  feePayer: 'platform',
  commissionOnPackages: true,
};

export async function getTerms(
  admin: SupabaseClient<Database>,
  providerId: string
): Promise<Terms> {
  const { data } = await admin
    .from('subscriptions')
    .select('commission_rate, commission_flat_cents, fee_payer, commission_on_packages')
    .eq('provider_id', providerId)
    .maybeSingle();
  if (!data) return { ...DEFAULT_TERMS };
  return {
    commissionRate: Number(data.commission_rate ?? DEFAULT_TERMS.commissionRate),
    commissionFlatCents: data.commission_flat_cents ?? 0,
    feePayer: (data.fee_payer as FeePayer) ?? 'platform',
    commissionOnPackages: data.commission_on_packages ?? true,
  };
}

/**
 * What Stripe will roughly charge to process `amountCents`.
 *
 * This is only ever an estimate: the real fee depends on how the parent pays
 * (PayNow is far cheaper than a card) and isn't known until after the payment.
 * It matters only when the vendor is absorbing the fee, where it has to be
 * baked into the application fee up front. The actual fee is read back off the
 * balance transaction afterwards and recorded, so the estimate never becomes
 * the number anyone reports on.
 *
 * Deliberately errs on the low side: over-charging a vendor for a fee Stripe
 * never levied is worse than BabyBrain absorbing a few cents of variance.
 */
export function estimateStripeFeeCents(amountCents: number): number {
  const percent = Number(process.env.STRIPE_FEE_ESTIMATE_PERCENT ?? '0.034');
  const flat = Number(process.env.STRIPE_FEE_ESTIMATE_FLAT_CENTS ?? '50');
  return Math.round(amountCents * percent) + flat;
}

export interface Split {
  /** What Stripe should move to BabyBrain as the application fee. */
  applicationFeeCents: number;
  /** The commission component of that — what BabyBrain actually keeps. */
  commissionCents: number;
  /** The Stripe-fee component, when the vendor is absorbing it. */
  feeRecoveryCents: number;
  /** What lands in the vendor's Stripe balance. */
  netCents: number;
}

/**
 * Split a sale under a set of terms.
 *
 * Charges are destination charges, so Stripe's fee always comes off the
 * platform balance. "Vendor pays the Stripe fee" is therefore implemented by
 * recovering it through the application fee, not by moving the charge onto
 * the vendor's account — which would also move dispute liability to them.
 */
export function computeSplit(amountCents: number, terms: Terms): Split {
  const commission = Math.round(amountCents * terms.commissionRate) + terms.commissionFlatCents;
  const feeRecovery = terms.feePayer === 'vendor' ? estimateStripeFeeCents(amountCents) : 0;

  // Never let the deductions exceed the sale: a flat fee on a cheap class, or
  // a fee recovery on a $2 booking, must not produce a negative transfer (which
  // Stripe rejects) or a vendor who owes money for making a sale.
  const applicationFee = Math.min(commission + feeRecovery, amountCents);
  const cappedCommission = Math.min(commission, applicationFee);
  return {
    applicationFeeCents: applicationFee,
    commissionCents: cappedCommission,
    feeRecoveryCents: applicationFee - cappedCommission,
    netCents: amountCents - applicationFee,
  };
}

/**
 * Stripe's real processing fee for a payment, plus the transfer it created.
 *
 * Read from the charge's balance transaction. Returns nulls rather than
 * throwing: this is bookkeeping detail, and a sale must still be recorded if
 * Stripe is slow or the shape is unexpected.
 */
export async function actualChargeCosts(
  paymentIntentId: string
): Promise<{ feeCents: number | null; transferId: string | null; currency: string | null }> {
  try {
    const intent = await getStripe().paymentIntents.retrieve(paymentIntentId, {
      expand: ['latest_charge.balance_transaction'],
    });
    const charge = intent.latest_charge as Stripe.Charge | null;
    if (!charge) return { feeCents: null, transferId: null, currency: null };
    const txn = charge.balance_transaction as Stripe.BalanceTransaction | string | null;
    const transfer = typeof charge.transfer === 'string' ? charge.transfer : charge.transfer?.id ?? null;
    return {
      feeCents: txn && typeof txn !== 'string' ? txn.fee : null,
      transferId: transfer,
      currency: charge.currency ?? null,
    };
  } catch {
    return { feeCents: null, transferId: null, currency: null };
  }
}

/**
 * The facts Stripe holds about a completed payment. Preferred over anything
 * we computed at checkout time: it reflects what was actually charged, what
 * Stripe actually took, and whether a transfer to the vendor actually
 * happened (their Connect status can change between checkout and payment).
 */
interface ChargeFacts {
  grossCents: number | null;
  applicationFeeCents: number | null;
  stripeFeeCents: number | null;
  transferId: string | null;
  currency: string | null;
}

async function chargeFacts(paymentIntentId: string): Promise<ChargeFacts> {
  const empty: ChargeFacts = {
    grossCents: null,
    applicationFeeCents: null,
    stripeFeeCents: null,
    transferId: null,
    currency: null,
  };
  try {
    const intent = await getStripe().paymentIntents.retrieve(paymentIntentId, {
      expand: ['latest_charge.balance_transaction'],
    });
    const charge = intent.latest_charge as Stripe.Charge | null;
    if (!charge) return empty;
    const txn = charge.balance_transaction as Stripe.BalanceTransaction | string | null;
    return {
      grossCents: charge.amount ?? null,
      applicationFeeCents: charge.application_fee_amount ?? null,
      stripeFeeCents: txn && typeof txn !== 'string' ? txn.fee : null,
      transferId: typeof charge.transfer === 'string' ? charge.transfer : charge.transfer?.id ?? null,
      currency: charge.currency ?? null,
    };
  } catch {
    return empty;
  }
}

export interface SaleInput {
  providerId: string;
  source: 'booking' | 'package';
  bookingId?: string | null;
  packagePurchaseId?: string | null;
  /** Price as the app knows it; Stripe's figure wins when available. */
  grossCents: number;
  paymentIntentId: string | null;
}

/**
 * Record a sale on the provider's earnings ledger.
 *
 * Idempotent on the payment intent — the Stripe webhook and
 * /api/stripe/reconcile both process the same checkout, and a unique index
 * backs this up in case the two race. Never throws: a bookkeeping failure
 * must not undo a booking the parent has already paid for.
 */
export async function recordSale(
  admin: SupabaseClient<Database>,
  input: SaleInput
): Promise<void> {
  try {
    if (input.paymentIntentId) {
      const { data: already } = await admin
        .from('provider_earnings')
        .select('id')
        .eq('stripe_payment_intent', input.paymentIntentId)
        .maybeSingle();
      if (already) return;
    }

    const facts = input.paymentIntentId
      ? await chargeFacts(input.paymentIntentId)
      : ({ grossCents: null, applicationFeeCents: null, stripeFeeCents: null, transferId: null, currency: null } as ChargeFacts);

    const terms = await getTerms(admin, input.providerId);
    const gross = facts.grossCents ?? input.grossCents;
    const effectiveTerms =
      input.source === 'package' && !terms.commissionOnPackages
        ? { ...terms, commissionRate: 0, commissionFlatCents: 0 }
        : terms;
    const split = computeSplit(gross, effectiveTerms);

    // A transfer id is the only proof the money actually reached the vendor's
    // own Stripe account. Without one, BabyBrain is holding their share.
    const routedToConnect = Boolean(facts.transferId);

    // Prefer the application fee Stripe actually took over the one we intended
    // — they only diverge if terms changed between checkout and payment, and
    // the vendor's ledger should show what really happened.
    const appliedFee = facts.applicationFeeCents ?? split.applicationFeeCents;
    // Of that fee, the part that isn't recovering Stripe's cost is what
    // BabyBrain keeps.
    const commissionCents = Math.max(0, appliedFee - split.feeRecoveryCents);

    await admin.from('provider_earnings').insert({
      provider_id: input.providerId,
      source: input.source,
      booking_id: input.bookingId ?? null,
      package_purchase_id: input.packagePurchaseId ?? null,
      currency: facts.currency ?? 'sgd',
      gross_cents: gross,
      commission_cents: commissionCents,
      stripe_fee_cents: facts.stripeFeeCents,
      net_cents: gross - appliedFee,
      commission_rate: effectiveTerms.commissionRate,
      commission_flat_cents: effectiveTerms.commissionFlatCents,
      fee_payer: effectiveTerms.feePayer,
      routed_to_connect: routedToConnect,
      stripe_payment_intent: input.paymentIntentId,
      stripe_transfer_id: facts.transferId,
      status: routedToConnect ? 'pending' : 'platform_owed',
    });
  } catch {
    // Swallowed on purpose — see the doc comment.
  }
}
