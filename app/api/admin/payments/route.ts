import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin';
import { createAdminClient } from '@/lib/supabase/admin';
import { getStripe } from '@/lib/stripe';
import { fetchAll, testProviderIds } from '@/lib/admin-test-data';
import { isLiveEarning } from '@/lib/admin-test-rules';
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
  const limit = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 1000) : 50;

  const admin = createAdminClient();
  const stripe = getStripe();

  // Live sales only by default: demo/QA vendors (providers.is_test) and Stripe test-mode
  // payments (livemode = false) are left out. ?include_test=1 shows everything.
  const includeTest = searchParams.get('include_test') === '1';
  const db = admin as unknown as SupabaseClient;
  const testProviders = includeTest ? new Set<string>() : await testProviderIds(db);

  const baseCols = 'id, provider_id, source, booking_id, package_purchase_id, gross_cents, commission_cents, stripe_fee_cents, net_cents, fee_payer, routed_to_connect, status, stripe_payment_intent, currency, created_at';
  // `livemode` arrives with migration 00161 and the per-payment test flag `is_test` with 00212;
  // read whichever exist.
  let cols = baseCols;
  let testFlagAvailable = false;
  for (const extra of [', livemode, is_test', ', livemode']) {
    if (!(await db.from('provider_earnings').select(`${baseCols}${extra}`).limit(1)).error) { cols = `${baseCols}${extra}`; testFlagAvailable = extra.includes('is_test'); break; }
  }
  const readEarnings = () =>
    fetchAll<Record<string, unknown>>((f, t) =>
      db.from('provider_earnings').select(cols).order('created_at', { ascending: false }).range(f, t) as unknown as PromiseLike<{ data: Record<string, unknown>[] | null; error: { message: string } | null }>);

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

  // Why a payment is not live money, if it is not (shown as a chip when test data is included).
  const testReasonOf = (r: Record<string, unknown>): 'vendor' | 'stripe_test' | 'flagged' | null =>
    r.is_test ? 'flagged' : r.livemode === false ? 'stripe_test' : testProviderSet.has(String(r.provider_id)) ? 'vendor' : null;
  const testProviderSet = includeTest ? await testProviderIds(db) : testProviders;
  const isLive = (r: Record<string, unknown>) =>
    includeTest || isLiveEarning({
      vendorIsTest: testProviders.has(String(r.provider_id)), livemode: r.livemode as boolean | null | undefined, flaggedTest: r.is_test as boolean | null | undefined,
    });
  const live = rawEarnings.filter(isLive) as unknown as Array<{
    id: string; provider_id: string; source: string; booking_id: string | null; package_purchase_id: string | null;
    gross_cents: number; commission_cents: number;
    stripe_fee_cents: number | null; net_cents: number; fee_payer: string; routed_to_connect: boolean;
    status: string; stripe_payment_intent: string | null; currency: string; created_at: string;
    is_test?: boolean | null; livemode?: boolean | null;
  }>;
  const excludedSales = rawEarnings.length - live.length;
  const earningsRes = { data: live.slice(0, limit), error: null as { message: string } | null };
  const allRes = { data: live };

  const providerIds = [...new Set((earningsRes.data ?? []).map((r) => r.provider_id))];
  const { data: providerRows } = providerIds.length
    ? await admin.from('providers').select('id, business_name').in('id', providerIds)
    : { data: [] };
  const nameById = new Map((providerRows ?? []).map((p) => [p.id, p.business_name]));

  // Who paid: the parent behind the booking or the package purchase, when there is one.
  const bookingIds = (earningsRes.data ?? []).map((r) => r.booking_id).filter((x): x is string => !!x);
  const packageIds = (earningsRes.data ?? []).map((r) => r.package_purchase_id).filter((x): x is string => !!x);
  const [bookingRows, packageRows] = await Promise.all([
    bookingIds.length ? db.from('bookings').select('id, user_id').in('id', bookingIds) : Promise.resolve({ data: [] as { id: string; user_id: string | null }[] }),
    packageIds.length ? db.from('package_purchases').select('id, user_id').in('id', packageIds) : Promise.resolve({ data: [] as { id: string; user_id: string | null }[] }),
  ]);
  const payerIdOfBooking = new Map((bookingRows.data ?? []).map((b: { id: string; user_id: string | null }) => [b.id, b.user_id]));
  const payerIdOfPackage = new Map((packageRows.data ?? []).map((b: { id: string; user_id: string | null }) => [b.id, b.user_id]));
  const payerIds = [...new Set([...payerIdOfBooking.values(), ...payerIdOfPackage.values()].filter((x): x is string => !!x))];
  const { data: payerRows } = payerIds.length
    ? await db.from('parent_profiles').select('id, full_name, email').in('id', payerIds)
    : { data: [] as { id: string; full_name: string | null; email: string }[] };
  const payerById = new Map((payerRows ?? []).map((p: { id: string; full_name: string | null; email: string }) => [p.id, { id: p.id, name: p.full_name || p.email, email: p.email }]));
  const payerOf = (r: { booking_id: string | null; package_purchase_id: string | null }) => {
    const uid = (r.booking_id && payerIdOfBooking.get(r.booking_id)) || (r.package_purchase_id && payerIdOfPackage.get(r.package_purchase_id)) || null;
    return uid ? payerById.get(uid) ?? null : null;
  };

  const transactions = (earningsRes.data ?? []).map((r) => ({
    id: r.id,
    payer: payerOf(r),
    is_test: !!r.is_test,
    test_reason: testReasonOf(r as unknown as Record<string, unknown>),
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

  return NextResponse.json({ transactions, totals, platformPayouts, platformPayoutsError, includeTest, excludedSales, testFlagAvailable });
}
