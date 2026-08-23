import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getStripe } from '@/lib/stripe';
import type { Database } from '@/types/database';

/**
 * Shared Stripe Connect (Express) helpers for the vendor payout flow.
 *
 * The provider row only stores `stripe_account_id` + `payouts_enabled`;
 * everything else (what Stripe still wants, why payouts are held, the
 * balance) is read live from Stripe so the vendor sees the truth even when
 * the `account.updated` webhook is delayed or never lands.
 */

/** Where a provider sits in the payout-onboarding journey. */
export type ConnectState =
  | 'not_connected'      // never started
  | 'incomplete'         // account exists, onboarding form not finished
  | 'action_required'    // Stripe is asking for more information
  | 'pending'            // everything submitted, Stripe still verifying
  | 'active';            // charges + payouts on

export interface ConnectStatus {
  state: ConnectState;
  account_id: string | null;
  details_submitted: boolean;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  /** Why Stripe has disabled the account, when it has. */
  disabled_reason: string | null;
  /** Raw Stripe requirement keys still owed — the SPA prettifies these. */
  requirements_due: string[];
  past_due: string[];
  pending_verification: string[];
  /** ISO deadline after which payouts stop, when Stripe has set one. */
  deadline: string | null;
  /** e.g. "daily", "weekly" — how often Stripe pays out. */
  payout_interval: string | null;
  /** Destination bank account, when one has been added. */
  bank_last4: string | null;
  bank_name: string | null;
  /** Connected-account balance, in cents, when readable. */
  balance: { currency: string; available: number; pending: number } | null;
}

const NOT_CONNECTED: ConnectStatus = {
  state: 'not_connected',
  account_id: null,
  details_submitted: false,
  charges_enabled: false,
  payouts_enabled: false,
  disabled_reason: null,
  requirements_due: [],
  past_due: [],
  pending_verification: [],
  deadline: null,
  payout_interval: null,
  bank_last4: null,
  bank_name: null,
  balance: null,
};

export const notConnected = (): ConnectStatus => ({ ...NOT_CONNECTED });

/**
 * Retrieve a connected account, tolerating an id that no longer resolves.
 * Accounts get deleted or rejected in the Stripe dashboard, and a stale id
 * on the provider row must not hard-fail the billing page — the caller
 * treats `null` as "start over".
 */
export async function fetchAccount(accountId: string): Promise<Stripe.Account | null> {
  try {
    return await getStripe().accounts.retrieve(accountId);
  } catch {
    return null;
  }
}

/** Read the connected account's own balance. Best-effort: never throws. */
async function fetchBalance(accountId: string): Promise<ConnectStatus['balance']> {
  try {
    const balance = await getStripe().balance.retrieve({}, { stripeAccount: accountId });
    const available = balance.available.find((b) => b.currency === 'sgd') ?? balance.available[0];
    const pending = balance.pending.find((b) => b.currency === 'sgd') ?? balance.pending[0];
    if (!available && !pending) return null;
    return {
      currency: (available ?? pending)!.currency,
      available: available?.amount ?? 0,
      pending: pending?.amount ?? 0,
    };
  } catch {
    return null;
  }
}

/** Map a Stripe account onto the state the vendor UI branches on. */
export function connectState(account: Stripe.Account): ConnectState {
  const req = account.requirements;
  const pastDue = req?.past_due ?? [];
  const currentlyDue = req?.currently_due ?? [];
  if (account.charges_enabled && account.payouts_enabled && !pastDue.length) return 'active';
  if (!account.details_submitted) return 'incomplete';
  if (pastDue.length || currentlyDue.length || req?.disabled_reason) return 'action_required';
  return 'pending';
}

/** Flatten a Stripe account into the status payload the SPA renders. */
export async function describeAccount(account: Stripe.Account): Promise<ConnectStatus> {
  const req = account.requirements;
  const external = account.external_accounts?.data?.find(
    (e): e is Stripe.BankAccount => e.object === 'bank_account'
  );
  return {
    state: connectState(account),
    account_id: account.id,
    details_submitted: Boolean(account.details_submitted),
    charges_enabled: Boolean(account.charges_enabled),
    payouts_enabled: Boolean(account.payouts_enabled),
    disabled_reason: req?.disabled_reason ?? null,
    // past_due first: those are the ones already blocking payouts.
    requirements_due: Array.from(new Set([...(req?.past_due ?? []), ...(req?.currently_due ?? [])])),
    past_due: req?.past_due ?? [],
    pending_verification: req?.pending_verification ?? [],
    deadline: req?.current_deadline ? new Date(req.current_deadline * 1000).toISOString() : null,
    payout_interval: account.settings?.payouts?.schedule?.interval ?? null,
    bank_last4: external?.last4 ?? null,
    bank_name: external?.bank_name ?? null,
    balance: await fetchBalance(account.id),
  };
}

/**
 * Mirror Stripe's verdict onto `providers.payouts_enabled` — the flag the
 * booking checkout reads to decide whether to split the charge to the
 * vendor. Writes only on a change so we don't churn the row on every poll.
 */
export async function syncPayoutsEnabled(
  admin: SupabaseClient<Database>,
  providerId: string,
  account: Stripe.Account,
  current?: boolean
): Promise<boolean> {
  const enabled = Boolean(account.charges_enabled && account.payouts_enabled);
  if (current !== enabled) {
    await admin.from('providers').update({ payouts_enabled: enabled }).eq('id', providerId);
  }
  return enabled;
}
