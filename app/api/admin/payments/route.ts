import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin';
import { createAdminClient } from '@/lib/supabase/admin';
import { getStripe } from '@/lib/stripe';

/**
 * Founder-facing payments overview: every sale's split (gross / commission /
 * Stripe's real fee / vendor net), and separately what Stripe has actually
 * paid out to BabyBrain's own bank account.
 *
 * These are two different things that are easy to conflate: `provider_earnings`
 * is BabyBrain's ledger of what it *collected*, stamped at the moment of
 * sale; the platform payouts list below is what Stripe has actually *settled*
 * to BabyBrain's bank on its own schedule (see lib/stripe.ts's payout
 * schedule comment) — a sale can show up in the ledger today and not reach
 * the bank for weeks.
 */
export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { searchParams } = new URL(request.url);
  const limit = Math.min(Number(searchParams.get('limit') ?? 50), 200);

  const admin = createAdminClient();
  const stripe = getStripe();

  const [earningsRes, allRes, payoutsRes] = await Promise.all([
    admin
      .from('provider_earnings')
      .select('id, provider_id, source, gross_cents, commission_cents, stripe_fee_cents, net_cents, fee_payer, routed_to_connect, status, stripe_payment_intent, currency, created_at')
      .order('created_at', { ascending: false })
      .limit(limit),
    // Summary totals over everything, not just the page being shown.
    admin
      .from('provider_earnings')
      .select('gross_cents, commission_cents, stripe_fee_cents, net_cents, status'),
    // What Stripe has actually sent to BabyBrain's own bank account.
    stripe.payouts.list({ limit: 20 }).catch(() => null),
  ]);

  if (earningsRes.error) {
    return NextResponse.json({ error: earningsRes.error.message }, { status: 400 });
  }

  const providerIds = [...new Set((earningsRes.data ?? []).map((r) => r.provider_id))];
  const { data: providerRows } = providerIds.length
    ? await admin.from('providers').select('id, business_name').in('id', providerIds)
    : { data: [] };
  const nameById = new Map((providerRows ?? []).map((p) => [p.id, p.business_name]));

  const transactions = (earningsRes.data ?? []).map((r) => ({
    id: r.id,
    provider_id: r.provider_id,
    business_name: nameById.get(r.provider_id) ?? '(unknown)',
    source: r.source,
    gross_cents: r.gross_cents,
    commission_cents: r.commission_cents,
    stripe_fee_cents: r.stripe_fee_cents,
    net_cents: r.net_cents,
    fee_payer: r.fee_payer,
    routed_to_connect: r.routed_to_connect,
    status: r.status,
    stripe_payment_intent: r.stripe_payment_intent,
    currency: r.currency,
    created_at: r.created_at,
  }));

  const totals = (allRes.data ?? []).reduce(
    (t, r) => {
      if (r.status === 'refunded') return t;
      t.gross += r.gross_cents;
      t.commission += r.commission_cents;
      t.stripeFee += r.stripe_fee_cents ?? 0;
      t.net += r.net_cents;
      if (r.status === 'platform_owed') t.platformOwed += r.net_cents;
      t.count += 1;
      return t;
    },
    { gross: 0, commission: 0, stripeFee: 0, net: 0, platformOwed: 0, count: 0 }
  );

  const platformPayouts =
    payoutsRes?.data.map((p) => ({
      id: p.id,
      amount_cents: p.amount,
      currency: p.currency,
      status: p.status,
      arrival_date: new Date(p.arrival_date * 1000).toISOString(),
      created: new Date(p.created * 1000).toISOString(),
      method: p.method,
    })) ?? null;

  return NextResponse.json({ transactions, totals, platformPayouts });
}
