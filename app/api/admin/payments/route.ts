import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin';
import { createAdminClient } from '@/lib/supabase/admin';
import { getStripe } from '@/lib/stripe';
import { fetchAll, testProviderIds } from '@/lib/admin-test-data';
import type { SupabaseClient } from '@supabase/supabase-js';

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
  // Not reachable through the shipped UI today (always sends limit=100), but
  // a non-numeric or negative value used to pass straight into .limit() with
  // nothing to catch it.
  const requested = Number(searchParams.get('limit') ?? 50);
  const limit = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 200) : 50;

  const admin = createAdminClient();
  const stripe = getStripe();

  // Live sales only by default: demo/QA vendors (providers.is_test) and Stripe test-mode
  // payments (livemode = false) are left out. ?include_test=1 shows everything.
  const includeTest = searchParams.get('include_test') === '1';
  const db = admin as unknown as SupabaseClient;
  const testProviders = includeTest ? new Set<string>() : await testProviderIds(db);

  const cols = 'id, provider_id, source, gross_cents, commission_cents, stripe_fee_cents, net_cents, fee_payer, routed_to_connect, status, stripe_payment_intent, currency, created_at';
  // `livemode` arrives with migration 00161; read without it until then.
  const readEarnings = async () => {
    const withMode = await fetchAll<Record<string, unknown>>((f, t) =>
      db.from('provider_earnings').select(`${cols}, livemode`).order('created_at', { ascending: false }).range(f, t));
    if (withMode.length) return withMode;
    return fetchAll<Record<string, unknown>>((f, t) =>
      db.from('provider_earnings').select(cols).order('created_at', { ascending: false }).range(f, t));
  };

  const [rawEarnings, payoutsRes] = await Promise.all([
    readEarnings(),
    // What Stripe has actually sent to BabyBrain's own bank account. Errors
    // are captured, not swallowed — a bad key or Stripe outage used to come
    // back as `null` here, which the frontend rendered identically to a
    // genuinely empty payout list ("No payouts yet"), masking a broken
    // integration as a normal zero-state on the one dashboard meant to give
    // financial oversight.
    stripe.payouts.list({ limit: 20 }).then(
      (r) => ({ ok: true as const, data: r.data }),
      (e) => ({ ok: false as const, message: e instanceof Error ? e.message : 'Could not reach Stripe' })
    ),
  ]);

  const isLive = (r: Record<string, unknown>) =>
    !testProviders.has(String(r.provider_id)) && (includeTest || r.livemode !== false);
  const live = rawEarnings.filter(isLive) as unknown as Array<{
    id: string; provider_id: string; source: string; gross_cents: number; commission_cents: number;
    stripe_fee_cents: number | null; net_cents: number; fee_payer: string; routed_to_connect: boolean;
    status: string; stripe_payment_intent: string | null; currency: string; created_at: string;
  }>;
  const excludedSales = rawEarnings.length - live.length;
  const earningsRes = { data: live.slice(0, limit), error: null as { message: string } | null };
  const allRes = { data: live };

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

  const platformPayouts = payoutsRes.ok
    ? payoutsRes.data.map((p) => ({
        id: p.id,
        amount_cents: p.amount,
        currency: p.currency,
        status: p.status,
        arrival_date: new Date(p.arrival_date * 1000).toISOString(),
        created: new Date(p.created * 1000).toISOString(),
        method: p.method,
      }))
    : null;
  const platformPayoutsError = payoutsRes.ok ? null : payoutsRes.message;

  return NextResponse.json({ transactions, totals, platformPayouts, platformPayoutsError, includeTest, excludedSales });
}
