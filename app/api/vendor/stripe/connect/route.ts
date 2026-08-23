import { NextResponse } from 'next/server';
import type Stripe from 'stripe';
import { getStripe } from '@/lib/stripe';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireProviderRole } from '@/lib/vendor';
import { vendorPageUrl } from '@/lib/cors';
import {
  connectState,
  describeAccount,
  fetchAccount,
  notConnected,
  syncPayoutsEnabled,
  type ConnectStatus,
} from '@/lib/stripe-connect';

/**
 * Stripe Connect (Express) payouts for a vendor.
 *
 *   GET  ?provider_id=…  → live payout status (any active member)
 *   POST { provider_id } → a Stripe-hosted URL to send the owner to
 *
 * Both read the account straight from Stripe and mirror the verdict onto
 * `providers.payouts_enabled` — the flag /api/bookings/checkout reads to
 * decide whether a booking charge is split to the vendor. Relying on the
 * `account.updated` webhook alone left vendors staring at "Not connected"
 * after finishing onboarding whenever that event didn't land.
 */

/**
 * Vendor websites come from scraping as often as from a form, so they arrive
 * as bare domains, blank strings, or junk. Stripe rejects a malformed — or
 * merely placeholder, e.g. example.com — business URL by failing the whole
 * account creation, so anything we aren't sure of is dropped instead of sent.
 */
function normalizeWebsite(raw: string | null): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let host: string;
  try {
    host = new URL(withScheme).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  if (!host.includes('.') || host.endsWith('.local')) return undefined;
  // Stripe blocks reserved/placeholder domains outright.
  if (/^(localhost|127\.|0\.0\.0\.0)/.test(host)) return undefined;
  if (/(^|\.)(example|test|invalid|localhost)\.(com|org|net|sg)$/.test(host)) return undefined;
  return withScheme;
}

/** Fields Stripe can prefill from what we already know about the business. */
function accountSeed(provider: {
  contact_email: string | null;
  business_name: string | null;
  website: string | null;
  contact_phone: string | null;
}): Stripe.AccountCreateParams {
  return {
    type: 'express',
    country: 'SG',
    email: provider.contact_email ?? undefined,
    // business_type is deliberately NOT set: it used to be pinned to
    // 'company', which forced sole proprietors and individual instructors
    // down a company verification path (tax ID, directors, owners) they
    // could never complete. Express onboarding asks for it instead.
    capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
    business_profile: {
      name: provider.business_name ?? undefined,
      url: normalizeWebsite(provider.website),
      support_email: provider.contact_email ?? undefined,
      support_phone: provider.contact_phone ?? undefined,
    },
    // Vendor "autopay": once onboarding + verification finish, payouts go
    // out automatically on this schedule rather than needing anyone to
    // trigger them manually. Express accounts default to daily anyway, but
    // set it explicitly so it doesn't depend on Stripe's own default.
    settings: { payouts: { schedule: { interval: 'daily' } } },
  };
}

const PROVIDER_COLUMNS = 'stripe_account_id, payouts_enabled, contact_email, business_name, website, contact_phone';

type ProviderRow = {
  stripe_account_id: string | null;
  payouts_enabled: boolean;
  contact_email: string | null;
  business_name: string | null;
  website: string | null;
  contact_phone: string | null;
};

/** Live payout status for the billing page. Any active member may read it. */
export async function GET(request: Request) {
  const providerId = new URL(request.url).searchParams.get('provider_id');
  if (!providerId) {
    return NextResponse.json({ error: 'provider_id required' }, { status: 400 });
  }
  const auth = await requireProviderRole(request, providerId, 'staff');
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const admin = createAdminClient();
  const { data: provider } = await admin
    .from('providers')
    .select(PROVIDER_COLUMNS)
    .eq('id', providerId)
    .maybeSingle<ProviderRow>();

  if (!provider?.stripe_account_id) {
    return NextResponse.json({ status: notConnected() } satisfies { status: ConnectStatus });
  }

  const account = await fetchAccount(provider.stripe_account_id);
  if (!account) {
    // The account was deleted or rejected on Stripe's side. Clear the stale
    // id so the next "Connect payouts" starts a fresh one instead of looping
    // on an account that can never be onboarded.
    await admin
      .from('providers')
      .update({ stripe_account_id: null, payouts_enabled: false })
      .eq('id', providerId);
    return NextResponse.json({ status: notConnected() });
  }

  await syncPayoutsEnabled(admin, providerId, account, provider.payouts_enabled);
  return NextResponse.json({ status: await describeAccount(account) });
}

/**
 * Create/refresh the Stripe-hosted URL the owner needs next:
 *  - no account yet, or onboarding unfinished / more info wanted
 *      → an `account_onboarding` link
 *  - fully onboarded
 *      → an Express dashboard login link (payouts, bank details, statements)
 *
 * Owner-only. Returns { url, kind, status }.
 */
export async function POST(request: Request) {
  const { provider_id: providerId } = (await request.json().catch(() => ({}))) as {
    provider_id?: string;
  };
  if (!providerId) {
    return NextResponse.json({ error: 'provider_id required' }, { status: 400 });
  }
  const auth = await requireProviderRole(request, providerId, 'owner');
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const admin = createAdminClient();
  const stripe = getStripe();

  const { data: provider } = await admin
    .from('providers')
    .select(PROVIDER_COLUMNS)
    .eq('id', providerId)
    .maybeSingle<ProviderRow>();
  if (!provider) {
    return NextResponse.json({ error: 'Business not found' }, { status: 404 });
  }

  // Reuse the existing account when it still resolves; a deleted/rejected one
  // is replaced rather than retried forever.
  let account: Stripe.Account | null = provider.stripe_account_id
    ? await fetchAccount(provider.stripe_account_id)
    : null;

  if (!account) {
    const seed = { ...accountSeed(provider), metadata: { provider_id: providerId } };
    try {
      account = await stripe.accounts.create(seed);
    } catch {
      // The prefill is a convenience, never a reason to block onboarding: if
      // Stripe objects to anything we guessed from the provider row, create
      // the bare account and let Express collect it all first-hand.
      try {
        const { business_profile: _dropped, ...bare } = seed;
        account = await stripe.accounts.create(bare);
      } catch (e) {
        // Most often: Connect isn't enabled on the platform account yet.
        const message = e instanceof Error ? e.message : 'Could not create a payout account';
        return NextResponse.json({ error: message }, { status: 502 });
      }
    }
    await admin
      .from('providers')
      .update({ stripe_account_id: account.id, payouts_enabled: false })
      .eq('id', providerId);
  } else {
    await syncPayoutsEnabled(admin, providerId, account, provider.payouts_enabled);
  }

  const state = connectState(account);
  const done = state === 'active' || state === 'pending';

  try {
    if (done) {
      // Finished onboarding → send them to their Express dashboard, where
      // payouts, bank details and statements live.
      const login = await stripe.accounts.createLoginLink(account.id);
      return NextResponse.json({
        url: login.url,
        kind: 'dashboard',
        status: await describeAccount(account),
      });
    }

    // Account links are single-use and expire in minutes, so this is always
    // minted fresh rather than stored.
    const link = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: vendorPageUrl(request, '/billing', 'connect=refresh'),
      return_url: vendorPageUrl(request, '/billing', 'connect=done'),
      type: 'account_onboarding',
      collection_options: { fields: 'eventually_due' },
    });
    return NextResponse.json({
      url: link.url,
      kind: 'onboarding',
      status: await describeAccount(account),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Could not open Stripe';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
