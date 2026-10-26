import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/admin';
import { createAdminClient } from '@/lib/supabase/admin';
import { invalidateParents, summariseDevices } from '@/lib/admin-parents';
import { classifyParent } from '@/lib/admin-test-rules';
import { logAdminAction } from '@/lib/admin-audit';
import { OVERRIDE_LABEL, applyOverride, parseOverride } from '@/lib/admin-test-override';
import { getStripe } from '@/lib/stripe';

/**
 * One parent, for the /admin → Parents detail panel.
 *
 * GET   — everything held on the account: profile, consent and terms, children,
 *         preferences, plan, and booking history.
 * PATCH — { is_test: boolean } marks / unmarks the account as a test account.
 */

type Params = { params: Promise<{ id: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request, { params }: Params) {
  const auth = await requireAdmin(request, ['admin', 'support']);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: 'No such parent.' }, { status: 404 });
  const db = createAdminClient() as unknown as SupabaseClient;

  // Everything below is scoped to this one parent. This panel used to call loadParents(), which reads
  // every parent, child, booking and earning in the database (plus up to 5,000 Stripe invoices) to
  // work out a handful of flags for one row; on a cold cache that took many seconds.
  const subQuery = db.from('customer_subscriptions')
    .select('plan, billing_interval, status, current_period_end, cancel_at_period_end, stripe_customer_id').eq('user_id', id).maybeSingle();

  // What the parent has paid for their plan lives only in Stripe: read their paid invoices, started as
  // soon as the customer id is known so it overlaps the other reads. If Stripe can't be reached (or the
  // customer is from the other Stripe mode) or is slow, the panel just omits it.
  type PlanPayment = { id: string; paidAt: string; amount: number; currency: string; description: string | null };
  const planPaymentsQuery: Promise<PlanPayment[]> = Promise.resolve(subQuery).then(async (r) => {
    const customerId = (r.data as { stripe_customer_id?: string | null } | null)?.stripe_customer_id;
    if (!customerId) return [];
    try {
      const list = await Promise.race([
        getStripe().invoices.list({ customer: customerId, status: 'paid', limit: 24 }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('stripe timeout')), 4000)),
      ]);
      return list.data
        .filter((i) => i.amount_paid > 0)
        .map((i) => ({
          id: i.id ?? '',
          paidAt: new Date((i.status_transitions?.paid_at ?? i.created) * 1000).toISOString(),
          amount: i.amount_paid / 100,
          currency: i.currency,
          description: i.lines.data[0]?.description ?? null,
        }));
    } catch { return []; }
  });

  const [profile, kids, prefs, sub, bookings, packages, seats, heldCount, devices, planPayments, tokens] = await Promise.all([
    db.from('parent_profiles').select('*').eq('id', id).maybeSingle(),
    db.from('children').select('id, name, date_of_birth, gender, interests, notes, created_at').eq('parent_id', id).order('date_of_birth', { ascending: false }),
    db.from('user_preferences').select('preferred_days, preferred_times, preferred_regions, budget_min, budget_max, interests').eq('user_id', id).maybeSingle(),
    subQuery,
    db.from('bookings')
      .select('id, status, payment_status, amount, created_at, guest_name, child_id, package_purchase_id, cancel_refund_mode, session:activity_sessions(starts_at, activity:activities(title))')
      .eq('user_id', id).order('created_at', { ascending: false }).limit(100),
    db.from('package_purchases')
      .select('id, credits_total, credits_remaining, status, created_at, expires_at, stripe_payment_intent, package:packages(name, price_cents), provider:providers(business_name)')
      .eq('user_id', id).order('created_at', { ascending: false }),
    db.from('provider_members').select('provider:providers(business_name, is_test)').eq('user_id', id).eq('status', 'active'),
    // Bookings the parent actually holds (not cancelled / waitlisted); counted, not listed, so it holds past the 100 shown.
    db.from('bookings').select('id', { count: 'exact', head: true }).eq('user_id', id).not('status', 'in', '("cancelled","waitlisted")'),
    // Until migration 00215 is applied this read fails and the parent just shows no device.
    Promise.resolve(db.from('parent_devices').select('os, surface, last_seen_at').eq('user_id', id)).then((r) => r.data ?? [], () => []),
    planPaymentsQuery,
    // Make-up tokens this parent holds or has used. A failed read leaves the section empty rather than the panel broken.
    db.from('make_up_tokens')
      .select('id, status, created_at, expires_at, auto_issued, child_id, origin_booking_id, redeemed_booking_id, provider:providers(business_name)')
      .eq('user_id', id).order('created_at', { ascending: false }).limit(200),
  ]);
  if (profile.error) return NextResponse.json({ error: profile.error.message }, { status: 500 });
  if (!profile.data) return NextResponse.json({ error: 'No such parent.' }, { status: 404 });

  const p = profile.data as Record<string, unknown> & { email: string; is_test?: boolean | null; is_real_override?: boolean | null };
  // The same shared rule the Parents list uses (lib/admin-test-rules.ts) decides the status.
  const seatList = ((seats.data ?? []) as unknown as { provider: { business_name: string | null; is_test: boolean | null } | null }[])
    .map((r) => r.provider).filter((v): v is { business_name: string | null; is_test: boolean | null } => !!v);
  const cls = classifyParent({
    email: p.email, manualTest: p.is_test, forcedReal: p.is_real_override,
    seats: seatList.map((v) => ({ isTestVendor: !!v.is_test })),
    hasParentActivity: (kids.data?.length ?? 0) > 0 || (heldCount.count ?? 0) > 0,
  });
  const dev = summariseDevices(devices as { os: string; surface: string; last_seen_at: string }[]);

  // Make-up tokens: where each came from (the cancelled booking), where it was used, and who it is for.
  type TokenRow = {
    id: string; status: string; created_at: string; expires_at: string | null; auto_issued: boolean | null;
    child_id: string | null; origin_booking_id: string | null; redeemed_booking_id: string | null;
    provider: { business_name: string | null } | null;
  };
  const tokenRows = (tokens.error ? [] : (tokens.data ?? [])) as unknown as TokenRow[];
  const tokenBookingIds = [...new Set(tokenRows.flatMap((t) => [t.origin_booking_id, t.redeemed_booking_id]).filter((v): v is string => !!v))];
  type TokenBooking = { id: string; session: { starts_at: string; activity: { title: string } | null } | null };
  const tokenBookings = tokenBookingIds.length
    ? ((await db.from('bookings').select('id, session:activity_sessions(starts_at, activity:activities(title))').in('id', tokenBookingIds)).data ?? []) as unknown as TokenBooking[]
    : [];
  const bookingById = new Map(tokenBookings.map((b) => [b.id, b]));
  const kidNameById = new Map(((kids.data ?? []) as { id: string; name: string }[]).map((k) => [k.id, k.name]));
  const bookingInfo = (bid: string | null) => {
    const b = bid ? bookingById.get(bid) : null;
    return b ? { activity: b.session?.activity?.title ?? null, startsAt: b.session?.starts_at ?? null } : null;
  };
  const nowMs = Date.now();
  const makeUpTokens = tokenRows.map((t) => ({
    id: t.id,
    // A token past its expiry that is still marked issued is no longer usable, whatever the nightly job has stamped.
    status: t.status === 'issued' && t.expires_at && Date.parse(t.expires_at) < nowMs ? 'expired' : t.status,
    createdAt: t.created_at,
    expiresAt: t.expires_at,
    auto: !!t.auto_issued,
    vendor: t.provider?.business_name ?? null,
    forChild: t.child_id ? kidNameById.get(t.child_id) ?? null : null,
    from: bookingInfo(t.origin_booking_id),
    usedOn: bookingInfo(t.redeemed_booking_id),
  }));
  return NextResponse.json({
    profile: p,
    children: kids.data ?? [],
    preferences: prefs.data ?? null,
    subscription: sub.data ?? null,
    planPayments,
    bookings: bookings.data ?? [],
    packages: packages.data ?? [],
    makeUpTokens,
    isTest: cls.kind === 'test',
    testSource: cls.testSource,
    testReason: cls.testReason,
    kind: cls.kind,
    override: p.is_test ? 'test' : p.is_real_override ? 'real' : 'auto',
    isVendor: cls.isVendor,
    vendorNames: [...new Set(seatList.map((v) => v.business_name).filter((n): n is string => !!n))],
    devices: dev.devices,
    surface: dev.surface,
    lastSeenAt: dev.lastSeenAt,
  });
}

export async function PATCH(request: Request, { params }: Params) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: 'No such parent.' }, { status: 404 });
  const mode = parseOverride((await request.json().catch(() => null)) as { mode?: unknown; is_test?: unknown } | null);
  if (!mode) return NextResponse.json({ error: "Expected { mode: 'auto' | 'test' | 'real' }." }, { status: 400 });

  const db = createAdminClient() as unknown as SupabaseClient;
  const r = await applyOverride(db, [id], mode);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  if (r.rows.length === 0) return NextResponse.json({ error: 'No such parent.' }, { status: 404 });
  invalidateParents();
  await logAdminAction(db, { ...auth.user, role: auth.role }, {
    action: `parent.override_${mode}`, entityType: 'parent', entityId: id,
    summary: `${r.rows[0].email} ${OVERRIDE_LABEL[mode]}`,
  });
  return NextResponse.json({ ok: true, mode, is_test: mode === 'test' });
}
