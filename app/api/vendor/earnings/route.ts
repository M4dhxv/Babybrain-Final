import { NextResponse } from 'next/server';
import type Stripe from 'stripe';
import { getStripe } from '@/lib/stripe';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireProviderRole } from '@/lib/vendor';

/**
 * A vendor's money: what they've earned, what they're still owed, and when
 * Stripe paid it out.
 *
 * GET ?provider_id=…&limit=…  — any active member of the business.
 *
 * The ledger comes from `provider_earnings` (written by the Stripe webhook /
 * reconcile), while payouts and the balance are read live from Stripe, which
 * is authoritative for those. Earnings BabyBrain collected on the vendor's
 * behalf — because they hadn't finished Connect onboarding at the time — are
 * reported separately, since Stripe will never pay those out.
 */

const LEDGER_LIMIT = 100;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const providerId = url.searchParams.get('provider_id');
  if (!providerId) {
    return NextResponse.json({ error: 'provider_id required' }, { status: 400 });
  }
  const auth = await requireProviderRole(request, providerId, 'staff');
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const admin = createAdminClient();

  const [{ data: provider }, { data: rows }] = await Promise.all([
    admin
      .from('providers')
      .select('stripe_account_id, payouts_enabled')
      .eq('id', providerId)
      .maybeSingle(),
    admin
      .from('provider_earnings')
      // Every column here is the vendor's own money detail — nothing to hide.
      .select('*')
      .eq('provider_id', providerId)
      .order('created_at', { ascending: false })
      .limit(Math.min(Number(url.searchParams.get('limit') ?? LEDGER_LIMIT), LEDGER_LIMIT)),
  ]);

  const ledger = rows ?? [];

  // Totals are computed over the whole ledger, not just the page shown, so
  // "still owed" doesn't quietly drop older unpaid sales.
  const { data: allRows } = await admin
    .from('provider_earnings')
    .select('net_cents, gross_cents, commission_cents, stripe_fee_cents, status')
    .eq('provider_id', providerId);

  const sum = (
    pick: (r: NonNullable<typeof allRows>[number]) => number | null,
    where: (r: NonNullable<typeof allRows>[number]) => boolean = () => true
  ) => (allRows ?? []).filter(where).reduce((total, r) => total + (pick(r) ?? 0), 0);

  const summary = {
    lifetime_gross_cents: sum((r) => r.gross_cents),
    lifetime_net_cents: sum((r) => r.net_cents, (r) => r.status !== 'refunded'),
    lifetime_commission_cents: sum((r) => r.commission_cents, (r) => r.status !== 'refunded'),
    lifetime_stripe_fee_cents: sum((r) => r.stripe_fee_cents, (r) => r.status !== 'refunded'),
    paid_out_cents: sum((r) => r.net_cents, (r) => r.status === 'paid_out'),
    // Money sitting in the vendor's own Stripe balance, on its way to them.
    awaiting_payout_cents: sum(
      (r) => r.net_cents,
      (r) => r.status === 'pending' || r.status === 'in_transit'
    ),
    // Money BabyBrain took on their behalf and settles directly.
    owed_by_babybrain_cents: sum((r) => r.net_cents, (r) => r.status === 'platform_owed'),
    sales_count: (allRows ?? []).length,
  };

  // Live from Stripe: the balance and the actual payout history.
  let balance: { currency: string; available: number; pending: number } | null = null;
  let payouts: Array<{
    id: string;
    amount: number;
    currency: string;
    status: string;
    arrival_date: string | null;
    created: string;
    bank_last4: string | null;
    failure_message: string | null;
  }> = [];

  if (provider?.stripe_account_id) {
    const stripe = getStripe();
    const account = provider.stripe_account_id;
    const [balanceResult, payoutResult] = await Promise.allSettled([
      stripe.balance.retrieve({}, { stripeAccount: account }),
      stripe.payouts.list({ limit: 20 }, { stripeAccount: account }),
    ]);

    if (balanceResult.status === 'fulfilled') {
      const b = balanceResult.value;
      const available = b.available.find((x) => x.currency === 'sgd') ?? b.available[0];
      const pending = b.pending.find((x) => x.currency === 'sgd') ?? b.pending[0];
      if (available || pending) {
        balance = {
          currency: (available ?? pending)!.currency,
          available: available?.amount ?? 0,
          pending: pending?.amount ?? 0,
        };
      }
    }

    if (payoutResult.status === 'fulfilled') {
      payouts = payoutResult.value.data.map((p: Stripe.Payout) => ({
        id: p.id,
        amount: p.amount,
        currency: p.currency,
        status: p.status,
        arrival_date: p.arrival_date ? new Date(p.arrival_date * 1000).toISOString() : null,
        created: new Date(p.created * 1000).toISOString(),
        bank_last4:
          p.destination && typeof p.destination !== 'string' && 'last4' in p.destination
            ? (p.destination.last4 as string)
            : null,
        failure_message: p.failure_message ?? null,
      }));
    }
  }

  // Label each ledger row with the class or pack it came from. Done as a
  // second lookup rather than a nested select so it stays type-safe and one
  // missing relationship can't blank the whole ledger.
  const bookingIds = ledger.map((r) => r.booking_id).filter((id): id is string => Boolean(id));
  const purchaseIds = ledger
    .map((r) => r.package_purchase_id)
    .filter((id): id is string => Boolean(id));

  const labels = new Map<string, string>();
  if (bookingIds.length) {
    const { data: booked } = await admin
      .from('bookings')
      .select('id, session_id')
      .in('id', bookingIds);
    const sessionIds = (booked ?? []).map((b) => b.session_id).filter(Boolean);
    const { data: sessions } = sessionIds.length
      ? await admin
          .from('activity_sessions')
          .select('id, starts_at, activities(title)')
          .in('id', sessionIds)
      : { data: [] };
    const titleBySession = new Map(
      (sessions ?? []).map((sn) => [
        sn.id,
        (sn.activities as unknown as { title?: string } | null)?.title ?? 'Class booking',
      ])
    );
    for (const b of booked ?? []) {
      labels.set(b.id, titleBySession.get(b.session_id) ?? 'Class booking');
    }
  }
  if (purchaseIds.length) {
    const { data: purchases } = await admin
      .from('package_purchases')
      .select('id, package_id')
      .in('id', purchaseIds);
    const packageIds = (purchases ?? []).map((p) => p.package_id).filter(Boolean);
    const { data: packs } = packageIds.length
      ? await admin.from('packages').select('id, name').in('id', packageIds)
      : { data: [] };
    const nameByPackage = new Map((packs ?? []).map((pk) => [pk.id, pk.name]));
    for (const p of purchases ?? []) {
      labels.set(p.id, nameByPackage.get(p.package_id) ?? 'Class pack');
    }
  }

  const labelled = ledger.map((row) => ({
    ...row,
    label:
      labels.get(row.booking_id ?? '') ??
      labels.get(row.package_purchase_id ?? '') ??
      (row.source === 'package' ? 'Class pack' : 'Class booking'),
  }));

  return NextResponse.json({
    connected: Boolean(provider?.stripe_account_id),
    payouts_enabled: Boolean(provider?.payouts_enabled),
    summary,
    balance,
    payouts,
    ledger: labelled,
  });
}
