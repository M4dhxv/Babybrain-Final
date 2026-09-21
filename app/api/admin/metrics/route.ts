import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/admin';
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchAll, isTestEmail, testProviderIds } from '@/lib/admin-test-data';

/**
 * Founder KPI snapshot, sourced straight from the Supabase database.
 *
 * By default this counts LIVE activity only: demo/QA vendors (providers.is_test),
 * Stripe test-mode payments (provider_earnings.livemode = false) and test-looking
 * parent emails are left out, so the numbers measure real progress. Pass
 * ?include_test=1 to see everything. Nothing is ever deleted.
 */
export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const includeTest = new URL(request.url).searchParams.get('include_test') === '1';
  const admin = createAdminClient() as unknown as SupabaseClient;
  const now = Date.now();
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
  const DAY = 864e5;

  const testProviders = includeTest ? new Set<string>() : await testProviderIds(admin);

  const [providers, parents, activities, sessions, bookings, reviews, earnings, vendorSubs, plusSubs] =
    await Promise.all([
      fetchAll<{ id: string; status: string; created_at: string }>((f, t) =>
        admin.from('providers').select('id, status, created_at').range(f, t)),
      fetchAll<{ id: string; email: string; created_at: string }>((f, t) =>
        admin.from('parent_profiles').select('id, email, created_at').range(f, t)),
      fetchAll<{ id: string; provider_id: string; is_published: boolean }>((f, t) =>
        admin.from('activities').select('id, provider_id, is_published').range(f, t)),
      fetchAll<{ id: string; activity_id: string; starts_at: string; capacity: number | null; status: string }>((f, t) =>
        admin.from('activity_sessions').select('id, activity_id, starts_at, capacity, status').range(f, t)),
      fetchAll<{ id: string; user_id: string; session_id: string; status: string; payment_status: string; created_at: string }>((f, t) =>
        admin.from('bookings').select('id, user_id, session_id, status, payment_status, created_at').range(f, t)),
      fetchAll<{ id: string; user_id: string; activity_id: string }>((f, t) =>
        admin.from('reviews').select('id, user_id, activity_id').range(f, t)),
      // livemode may not exist before migration 00161: fall back to reading without it.
      (async () => {
        const cols = 'provider_id, gross_cents, commission_cents, stripe_fee_cents, net_cents, status, routed_to_connect, created_at';
        const withMode = await fetchAll<Record<string, unknown>>((f, t) =>
          admin.from('provider_earnings').select(`${cols}, livemode`).range(f, t));
        if (withMode.length) return withMode;
        return fetchAll<Record<string, unknown>>((f, t) => admin.from('provider_earnings').select(cols).range(f, t));
      })(),
      fetchAll<{ provider_id: string; plan: string; status: string }>((f, t) =>
        admin.from('subscriptions').select('provider_id, plan, status').range(f, t)),
      fetchAll<{ user_id: string; plan: string; status: string }>((f, t) =>
        admin.from('customer_subscriptions').select('user_id, plan, status').range(f, t)),
    ]);

  // ---- what counts as live -------------------------------------------------
  const liveProvider = (id: string) => !testProviders.has(id);
  const testParents = new Set(includeTest ? [] : parents.filter((p) => isTestEmail(p.email)).map((p) => p.id));
  const liveParent = (id: string) => !testParents.has(id);

  const liveProviders = providers.filter((p) => liveProvider(p.id));
  const liveParents = parents.filter((p) => liveParent(p.id));
  const providerOfActivity = new Map(activities.map((a) => [a.id, a.provider_id]));
  const liveActivities = activities.filter((a) => liveProvider(a.provider_id));
  const providerOfSession = new Map(sessions.map((s) => [s.id, providerOfActivity.get(s.activity_id) ?? null]));
  const liveBookings = bookings.filter((b) => {
    const prov = providerOfSession.get(b.session_id);
    // A booking whose session no longer exists has no known owner, so it is counted.
    return liveParent(b.user_id) && (prov == null || liveProvider(prov));
  });
  const liveReviews = reviews.filter((r) => liveParent(r.user_id) && liveProvider(providerOfActivity.get(r.activity_id) ?? ''));
  const liveEarnings = earnings.filter(
    (e) => liveProvider(String(e.provider_id)) && (includeTest || e.livemode !== false)
  );

  // ---- daily series (Singapore calendar days) -------------------------------
  const sgDate = (d: string) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
  const days: string[] = [];
  for (let i = 13; i >= 0; i--) days.push(sgDate(iso(i * DAY)));
  const bucket = (rows: { created_at: string }[]) => {
    const m = new Map<string, number>(days.map((d) => [d, 0]));
    for (const r of rows) {
      const d = sgDate(r.created_at);
      if (m.has(d)) m.set(d, (m.get(d) ?? 0) + 1);
    }
    return m;
  };
  const bBookings = bucket(liveBookings);
  const bSignups = bucket(liveParents);
  const daily = days.map((d) => ({ date: d, bookings: bBookings.get(d) ?? 0, signups: bSignups.get(d) ?? 0 }));
  const today = days[days.length - 1];
  const last7 = days.slice(-7);
  const sum = (m: Map<string, number>, keys: string[]) => keys.reduce((n, k) => n + (m.get(k) ?? 0), 0);

  // ---- revenue and commission ----------------------------------------------
  const sold = liveEarnings.filter((e) => e.status !== 'refunded');
  const n = (v: unknown) => Number(v ?? 0);
  const inWindow = (e: Record<string, unknown>, days_: number) => String(e.created_at) >= iso(days_ * DAY);
  const tally = (rows: Record<string, unknown>[]) => ({
    sales: rows.length,
    gross: rows.reduce((t, e) => t + n(e.gross_cents), 0),
    commission: rows.reduce((t, e) => t + n(e.commission_cents), 0),
    vendorNet: rows.reduce((t, e) => t + n(e.net_cents), 0),
    stripeFees: rows.reduce((t, e) => t + n(e.stripe_fee_cents), 0),
  });
  const revenue = {
    ...tally(sold),
    commissionCollected: sold.filter((e) => e.routed_to_connect).reduce((t, e) => t + n(e.commission_cents), 0),
    commissionToCollect: sold.filter((e) => !e.routed_to_connect).reduce((t, e) => t + n(e.commission_cents), 0),
    refunded: liveEarnings.filter((e) => e.status === 'refunded').length,
    last7: tally(sold.filter((e) => inWindow(e, 7))),
    last30: tally(sold.filter((e) => inWindow(e, 30))),
  };

  // ---- growth --------------------------------------------------------------
  const since = (rows: { created_at: string }[], d: number) => rows.filter((r) => r.created_at >= iso(d * DAY)).length;
  const publishedByProvider = new Set(liveActivities.filter((a) => a.is_published).map((a) => a.provider_id));
  const bookedProviders = new Set(
    liveBookings.map((b) => providerOfSession.get(b.session_id)).filter((p): p is string => !!p)
  );
  const growth = {
    newParents7: since(liveParents, 7),
    newParents30: since(liveParents, 30),
    newVendors30: since(liveProviders, 30),
    parentsWhoBooked: new Set(liveBookings.map((b) => b.user_id)).size,
    // A vendor that has gone live (active + a published class) and received a booking.
    activatedVendors: liveProviders.filter(
      (p) => p.status === 'active' && publishedByProvider.has(p.id) && bookedProviders.has(p.id)
    ).length,
  };

  // ---- booking health -------------------------------------------------------
  const b30 = liveBookings.filter((b) => b.created_at >= iso(30 * DAY));
  const cancelled30 = b30.filter((b) => b.status === 'cancelled').length;
  const held = new Map<string, number>();
  for (const b of liveBookings) {
    if (b.status === 'pending' || b.status === 'confirmed' || b.status === 'completed') {
      held.set(b.session_id, (held.get(b.session_id) ?? 0) + 1);
    }
  }
  const upcoming = sessions.filter(
    (s) => s.status !== 'cancelled' && s.starts_at >= new Date(now).toISOString() && s.capacity != null &&
      liveProvider(providerOfActivity.get(s.activity_id) ?? '')
  );
  const capacity = upcoming.reduce((t, s) => t + (s.capacity ?? 0), 0);
  const filled = upcoming.reduce((t, s) => t + Math.min(held.get(s.id) ?? 0, s.capacity ?? 0), 0);
  const health = {
    bookings30: b30.length,
    cancelled30,
    cancellationRate: b30.length ? cancelled30 / b30.length : null,
    waitlisted: liveBookings.filter((b) => b.status === 'waitlisted').length,
    upcomingFillRate: capacity ? filled / capacity : null,
    upcomingSessions: upcoming.length,
  };

  // ---- subscriptions -------------------------------------------------------
  const plusLive = plusSubs.filter((s) => s.plan === 'plus' && liveParent(s.user_id));
  const vendorLive = vendorSubs.filter((s) => liveProvider(s.provider_id));
  const count = (rows: { status: string }[], statuses: string[]) => rows.filter((r) => statuses.includes(r.status)).length;
  const subscriptions = {
    plusActive: count(plusLive, ['active', 'trialing']),
    plusPastDue: count(plusLive, ['past_due']),
    plusCanceled: count(plusLive, ['canceled']),
    vendorPro: count(vendorLive.filter((s) => s.plan === 'growth'), ['active', 'trialing']),
    vendorPremium: count(vendorLive.filter((s) => s.plan === 'pro' || s.plan === 'premium'), ['active', 'trialing']),
    vendorPastDue: count(vendorLive.filter((s) => s.plan !== 'free'), ['past_due']),
    vendorCanceled: count(vendorLive.filter((s) => s.plan !== 'free'), ['canceled']),
  };

  return NextResponse.json({
    includeTest,
    // What is being left out, so the founder can see the filter is doing something.
    excluded: {
      vendors: providers.length - liveProviders.length,
      parents: parents.length - liveParents.length,
      bookings: bookings.length - liveBookings.length,
      sales: earnings.length - liveEarnings.length,
    },
    totals: {
      parents: liveParents.length,
      providers: liveProviders.length,
      activeProviders: liveProviders.filter((p) => p.status === 'active').length,
      bookings: liveBookings.length,
      plusSubscribers: subscriptions.plusActive,
      growthSubscribers: subscriptions.vendorPro,
      reviews: liveReviews.length,
      activities: liveActivities.length,
    },
    bookings: { today: bBookings.get(today) ?? 0, last7: sum(bBookings, last7) },
    signups: { today: bSignups.get(today) ?? 0, last7: sum(bSignups, last7) },
    daily,
    revenue,
    growth,
    health,
    subscriptions,
  });
}
