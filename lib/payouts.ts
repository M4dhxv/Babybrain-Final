import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getStripe } from '@/lib/stripe';
import type { Database } from '@/types/database';

/**
 * Turning a Stripe payout into "this booking was paid out, on this date".
 *
 * Bookings are charged as destination charges, so on the vendor's connected
 * account each one shows up as its own charge whose `source_transfer` is the
 * platform transfer we stored on the earnings row. Walking a payout's balance
 * transactions therefore tells us exactly which earnings it covered.
 *
 * That mapping is best-effort: if Stripe's shape surprises us, the payout is
 * still recorded against the earnings by date, and the vendor's payout list —
 * which is read live from Stripe — is unaffected either way.
 */

const PAYOUT_STATUS: Record<string, 'in_transit' | 'paid_out' | 'pending'> = {
  paid: 'paid_out',
  in_transit: 'in_transit',
  pending: 'in_transit',
  failed: 'pending',
  canceled: 'pending',
};

/** The transfer ids a payout paid out, read from its balance transactions. */
async function transferIdsInPayout(accountId: string, payoutId: string): Promise<string[]> {
  const ids: string[] = [];
  try {
    const stripe = getStripe();
    for await (const txn of stripe.balanceTransactions.list(
      { payout: payoutId, expand: ['data.source'], limit: 100 },
      { stripeAccount: accountId }
    )) {
      const source = txn.source as Stripe.Charge | string | null;
      if (source && typeof source !== 'string' && 'source_transfer' in source) {
        const transfer = source.source_transfer;
        const id = typeof transfer === 'string' ? transfer : transfer?.id;
        if (id) ids.push(id);
      }
    }
  } catch {
    // Fall through to the date-based path below.
  }
  return ids;
}

/**
 * Apply a payout to a provider's earnings.
 *
 * Called from the Stripe webhook for Connect `payout.*` events, where
 * `accountId` is the vendor's connected account rather than the platform's.
 */
export async function applyPayout(
  admin: SupabaseClient<Database>,
  accountId: string,
  payout: Stripe.Payout
): Promise<void> {
  try {
    const { data: provider } = await admin
      .from('providers')
      .select('id')
      .eq('stripe_account_id', accountId)
      .maybeSingle();
    if (!provider) return;

    const status = PAYOUT_STATUS[payout.status] ?? 'pending';
    const arrived =
      payout.status === 'paid' && payout.arrival_date
        ? new Date(payout.arrival_date * 1000).toISOString()
        : null;

    const patch = {
      stripe_payout_id: payout.id,
      status,
      paid_out_at: arrived,
    };

    const transferIds = await transferIdsInPayout(accountId, payout.id);
    if (transferIds.length) {
      await admin
        .from('provider_earnings')
        .update(patch)
        .eq('provider_id', provider.id)
        .in('stripe_transfer_id', transferIds);
      return;
    }

    // No usable mapping (a payout that bundles more than per-charge transfers,
    // or an API hiccup). Fall back to the money that was sitting unpaid in the
    // vendor's Stripe balance when the payout was created — the same set, just
    // identified by time rather than by transfer.
    const createdAt = new Date(payout.created * 1000).toISOString();
    await admin
      .from('provider_earnings')
      .update(patch)
      .eq('provider_id', provider.id)
      .eq('routed_to_connect', true)
      .in('status', ['pending', 'in_transit'])
      .lte('created_at', createdAt);
  } catch {
    // Bookkeeping only — never fail the webhook over it.
  }
}
