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
  // 00053_vendor_covers_stripe_fee.sql moved every real vendor (and the
  // column default) to 'vendor' — this fallback only fires for a provider
  // with no subscriptions row yet, and had been left on the old 'platform'
  // default, so that one edge case could still silently absorb the fee.
  feePayer: 'vendor',
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
  /** False for a Stripe test-mode payment (the test site). Null when unknown. */
  livemode: boolean | null;
}

async function chargeFacts(paymentIntentId: string): Promise<ChargeFacts> {
  const empty: ChargeFacts = {
    grossCents: null,
    applicationFeeCents: null,
    stripeFeeCents: null,
    transferId: null,
    currency: null,
    livemode: null,
  };
  try {
    const intent = await getStripe().paymentIntents.retrieve(paymentIntentId, {
      expand: ['latest_charge.balance_transaction'],
    });
    const charge = intent.latest_charge as Stripe.Charge | null;
    if (!charge) return { ...empty, livemode: intent.livemode };
    const txn = charge.balance_transaction as Stripe.BalanceTransaction | string | null;
    return {
      grossCents: charge.amount ?? null,
      applicationFeeCents: charge.application_fee_amount ?? null,
      stripeFeeCents: txn && typeof txn !== 'string' ? txn.fee : null,
      transferId: typeof charge.transfer === 'string' ? charge.transfer : charge.transfer?.id ?? null,
      currency: charge.currency ?? null,
      livemode: intent.livemode,
    };
  } catch {
    return empty;
  }
}

/**
 * Turn what the app knows about a sale, plus what Stripe says about the charge, into the ledger
 * figures. Shared by {@link recordSale} (first write) and {@link healEarningsFromStripe} (a later
 * correction) so the two can never disagree about how a sale is split. Pure.
 */
export function deriveEarning(
  fallbackGrossCents: number,
  facts: ChargeFacts,
  terms: Terms,
  source: 'booking' | 'package'
) {
  const gross = facts.grossCents ?? fallbackGrossCents;
  const effectiveTerms =
    source === 'package' && !terms.commissionOnPackages ? { ...terms, commissionRate: 0, commissionFlatCents: 0 } : terms;
  const split = computeSplit(gross, effectiveTerms);
  // A transfer id is the only proof the money actually reached the vendor's own Stripe account.
  // Without one, BabyBrain is holding their share.
  const routedToConnect = Boolean(facts.transferId);
  // Prefer the application fee Stripe actually took over the one we intended — they only diverge if
  // terms changed between checkout and payment, and the ledger should show what really happened.
  const appliedFee = facts.applicationFeeCents ?? split.applicationFeeCents;
  // Of that fee, the part that isn't recovering Stripe's cost is what BabyBrain keeps.
  const commissionCents = Math.max(0, appliedFee - split.feeRecoveryCents);
  return {
    gross,
    effectiveTerms,
    routedToConnect,
    appliedFee,
    commissionCents,
    netCents: gross - appliedFee,
    status: (routedToConnect ? 'pending' : 'platform_owed') as 'pending' | 'platform_owed',
  };
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
      : ({ grossCents: null, applicationFeeCents: null, stripeFeeCents: null, transferId: null, currency: null, livemode: null } as ChargeFacts);

    const terms = await getTerms(admin, input.providerId);
    const d = deriveEarning(input.grossCents, facts, terms, input.source);
    const effectiveTerms = d.effectiveTerms;
    const gross = d.gross;
    const commissionCents = d.commissionCents;
    const routedToConnect = d.routedToConnect;

    await admin.from('provider_earnings').insert({
      provider_id: input.providerId,
      source: input.source,
      booking_id: input.bookingId ?? null,
      package_purchase_id: input.packagePurchaseId ?? null,
      currency: facts.currency ?? 'sgd',
      gross_cents: gross,
      commission_cents: commissionCents,
      stripe_fee_cents: facts.stripeFeeCents,
      net_cents: d.netCents,
      commission_rate: effectiveTerms.commissionRate,
      commission_flat_cents: effectiveTerms.commissionFlatCents,
      fee_payer: effectiveTerms.feePayer,
      routed_to_connect: routedToConnect,
      stripe_payment_intent: input.paymentIntentId,
      stripe_transfer_id: facts.transferId,
      status: d.status,
      // Only written for test-mode payments: live rows rely on the column default (true),
      // so recording a live sale never depends on migration 00161 having been applied.
      ...(facts.livemode === false ? { livemode: false } : {}),
    } as Database['public']['Tables']['provider_earnings']['Insert']);
  } catch {
    // Swallowed on purpose — see the doc comment.
  }
}


/**
 * Corrects ledger rows that were written WITHOUT Stripe's facts.
 *
 * {@link recordSale} reads the charge from Stripe and, if that read fails (a Stripe blip, a key not
 * available to the code that ran it), deliberately still records the sale from the app's own
 * figures — better than losing it. The cost is a row with no transfer id and no Stripe fee that
 * says `platform_owed` ("BabyBrain holds the vendor's share") even when Stripe already paid the
 * vendor straight away. Nothing ever revisited it. This re-reads the charge for such recent rows
 * and fixes whatever Stripe now tells us. It only touches rows still `platform_owed` with no
 * transfer and no fee, never a row that has moved on (in transit, paid out, refunded), and does
 * nothing unless Stripe answers.
 */
export async function healEarningsFromStripe(admin: SupabaseClient<Database>, limit = 20): Promise<number> {
  const { data: rows } = await admin
    .from('provider_earnings')
    .select('id, provider_id, source, gross_cents, commission_cents, net_cents, routed_to_connect, stripe_payment_intent, status')
    .not('stripe_payment_intent', 'is', null)
    .is('stripe_transfer_id', null)
    .is('stripe_fee_cents', null)
    .eq('status', 'platform_owed')
    .gt('created_at', new Date(Date.now() - 14 * 86_400_000).toISOString())
    .limit(limit);

  let healed = 0;
  for (const row of rows ?? []) {
    try {
      const facts = await chargeFacts(row.stripe_payment_intent as string);
      if (facts.grossCents == null) continue; // Stripe still can't tell us — leave it
      const terms = await getTerms(admin, row.provider_id);
      const d = deriveEarning(row.gross_cents, facts, terms, row.source as 'booking' | 'package');
      const unchanged =
        d.gross === row.gross_cents &&
        d.commissionCents === row.commission_cents &&
        d.netCents === row.net_cents &&
        d.routedToConnect === row.routed_to_connect &&
        facts.stripeFeeCents == null &&
        facts.transferId == null &&
        facts.livemode !== false;
      if (unchanged) continue;
      const { error } = await admin
        .from('provider_earnings')
        .update({
          gross_cents: d.gross,
          commission_cents: d.commissionCents,
          net_cents: d.netCents,
          stripe_fee_cents: facts.stripeFeeCents,
          routed_to_connect: d.routedToConnect,
          stripe_transfer_id: facts.transferId,
          status: d.status,
          ...(facts.livemode === false ? { livemode: false } : {}),
        } as Database['public']['Tables']['provider_earnings']['Update'])
        .eq('id', row.id)
        .eq('status', 'platform_owed');
      if (!error) healed++;
    } catch (e) {
      console.error('[healEarningsFromStripe] could not correct', row.id, e);
    }
  }
  return healed;
}
