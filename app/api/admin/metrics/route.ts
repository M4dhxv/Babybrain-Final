import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/admin';
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchAll, testProviderIds } from '@/lib/admin-test-data';
import {
  bookingBucket, classifyParent, countsAsParent, isLiveEarning, isManualBooking, isNeverConfirmed, isParentBooking,
} from '@/lib/admin-test-rules';

/**
 * Founder KPI snapshot, sourced straight from the Supabase database.
 *
 * By default this counts LIVE activity only: demo/QA vendors (providers.is_test),
 * Stripe test-mode payments (provider_earnings.livemode = false) and test-looking
 * parent emails (and vendor logins never used as a parent) are left out, so the numbers
 * measure real progress. A vendor who also books classes as a parent is counted. Who counts as
 * test, and which bookings count, is decided in lib/admin-test-rules.ts (with tests), the same
 * place the Parents list uses. Pass ?include_test=1 to see everything. Nothing is ever deleted.
 */
export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const includeTest = new URL(request.url).searchParams.get('include_test') === '1';
  const admin = createAdminClient() as unknown as SupabaseClient;
  const now = Date.now();
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
  const DAY = 864e5;

  // Vendors can book classes too, so a vendor login is NOT excluded just for holding a seat. It
  // is left out only if it has never been used as a parent (no children, no bookings) or works
  // only for test vendors — see vendorTestAccounts below.
  type SeatRow = { user_id: string; provider: { is_test: boolean | null } | null };
  const [testProviders, seatRows, kidParents] = includeTest
    ? [new Set<string>(), [] as SeatRow[], new Set<string>()]
    : await Promise.all([
        testProviderIds(admin),
        fetchAll<SeatRow>((f, t) =>
          admin.from('provider_members').select('user_id, provider:providers(is_test)').eq('status', 'active').range(f, t) as unknown as PromiseLike<{ data: SeatRow[] | null; error: { message: string } | null }>),
        fetchAll<{ parent_id: string }>((f, t) => admin.from('children').select('parent_id').range(f, t))
          .then((rows) => new Set(rows.map((r) => r.parent_id))),
      ]);

  // cancelled_from_status comes from migration 00210; until it is applied, fall back to inferring it.
  const hasCancelOrigin = !(await admin.from('bookings').select('cancelled_from_status').limit(1)).error;
  type BookingRow = {
    id: string; user_id: string; session_id: string; status: string; payment_status: string; amount: number | null;
    package_purchase_id: string | null; cancelled_from_status?: string | null; created_at: string;
    booking_group_id: string | null;
  };
  const bookingCols: string = `id, user_id, session_id, status, payment_status, amount, package_purchase_id, created_at, booking_group_id${hasCancelOrigin ? ', cancelled_from_status' : ''}`;

  const [providers, parents, activities, sessions, bookings, reviews, earnings, vendorSubs, plusSubs] =
    await Promise.all([
      fetchAll<{ id: string; status: string; created_at: string }>((f, t) =>
        admin.from('providers').select('id, status, created_at').range(f, t)),
      // is_test (migration 00207) and is_real_override (00212) are marked in /admin → Parents; read
      // whichever exist so the page keeps working before those migrations are applied.
      (async () => {
        type P = { id: string; email: string; created_at: string; is_test?: boolean | null; is_real_override?: boolean | null };
        let cols = 'id, email, created_at';
        for (const extra of [', is_test, is_real_override', ', is_test']) {
          if (!(await admin.from('parent_profiles').select(`${cols}${extra}`).range(0, 0)).error) { cols = `${cols}${extra}`; break; }
        }
        return fetchAll<P>((f, t) => admin.from('parent_profiles').select(cols).range(f, t) as unknown as PromiseLike<{ data: P[] | null; error: { message: string } | null }>);
      })(),
      fetchAll<{ id: string; provider_id: string; is_published: boolean }>((f, t) =>
        admin.from('activities').select('id, provider_id, is_published').range(f, t)),
      fetchAll<{ id: string; activity_id: string; starts_at: string; capacity: number | null; status: string }>((f, t) =>
        admin.from('activity_sessions').select('id, activity_id, starts_at, capacity, status').range(f, t)),
      fetchAll<BookingRow>((f, t) =>
        admin.from('bookings').select(bookingCols).range(f, t) as unknown as PromiseLike<{ data: BookingRow[] | null; error: { message: string } | null }>),
      fetchAll<{ id: string; user_id: string; activity_id: string }>((f, t) =>
        admin.from('reviews').select('id, user_id, activity_id').range(f, t)),
      // livemode comes from migration 00161 and is_test (a single payment flagged as test) from 00212;
      // read whichever exist.
      (async () => {
        let cols = 'provider_id, gross_cents, commission_cents, stripe_fee_cents, net_cents, status, routed_to_connect, created_at';
        for (const extra of [', livemode, is_test', ', livemode']) {
          if (!(await admin.from('provider_earnings').select(`${cols}${extra}`).limit(1)).error) { cols = `${cols}${extra}`; break; }
        }
        return fetchAll<Record<string, unknown>>((f, t) =>
          admin.from('provider_earnings').select(cols).range(f, t) as unknown as PromiseLike<{ data: Record<string, unknown>[] | null; error: { message: string } | null }>);
      })(),
      fetchAll<{ provider_id: string; plan: string; status: string }>((f, t) =>
        admin.from('subscriptions').select('provider_id, plan, status').range(f, t)),
      fetchAll<{ user_id: string; plan: string; status: string }>((f, t) =>
        admin.from('customer_subscriptions').select('user_id, plan, status').range(f, t)),
    ]);

  // ---- what counts as live -------------------------------------------------
  const liveProvider = (id: string) => !testProviders.has(id);
  const bookedUsers = new Set(bookings.filter(isParentBooking).map((b) => b.user_id));
  const seatsByUser = new Map<string, { isTestVendor: boolean }[]>();
  for (const s of seatRows) seatsByUser.set(s.user_id, [...(seatsByUser.get(s.user_id) ?? []), { isTestVendor: s.provider?.is_test === true }]);
  // One shared rule (lib/admin-test-rules.ts) decides who counts as a parent; test accounts and
  // vendor logins that were never used as a parent are left out.
  const testParents = new Set(
    includeTest ? [] : parents.filter((p) => !countsAsParent(classifyParent({
      email: p.email, manualTest: p.is_test, forcedReal: p.is_real_override,
      seats: seatsByUser.get(p.id), hasParentActivity: kidParents.has(p.id) || bookedUsers.has(p.id),
    }).kind)).map((p) => p.id)
  );
  const liveParent = (id: string) => !testParents.has(id);

  const liveProviders = providers.filter((p) => liveProvider(p.id));
  const liveParents = parents.filter((p) => liveParent(p.id));
  const providerOfActivity = new Map(activities.map((a) => [a.id, a.provider_id]));
  const liveActivities = activities.filter((a) => liveProvider(a.provider_id));
  const providerOfSession = new Map(sessions.map((s) => [s.id, providerOfActivity.get(s.activity_id) ?? null]));
  // A booking cancelled while pending or waitlisted was never a real booking, so it is left out of every
  // booking count and of the cancellation rate (isNeverConfirmed, lib/admin-test-rules.ts).
  // Test parents and test vendors are filtered first; `excluded.bookings` reports only those.
  const bookingsAfterTestFilter = bookings.filter((b) => {
    const prov = providerOfSession.get(b.session_id);
    // A booking whose session no longer exists has no known owner, so it is counted.
    return liveParent(b.user_id) && (prov == null || liveProvider(prov));
  });
  const liveBookings = bookingsAfterTestFilter.filter((b) => !isNeverConfirmed(b));
  // `liveBookings` is one row per SEAT: a parent booking two children is two rows sharing a
  // booking_group_id. Every "how many bookings" figure counts the booking instead, the same way the
  // Bookings list does (lib/admin-bookings.ts): one entry per group, booked at its earliest seat,
  // cancelled only when every seat is, and left out only when every seat was never confirmed.
  // Seats are still what fill a class, so the fill rate below stays on `liveBookings`.
  const seatsByBooking = new Map<string, BookingRow[]>();
  for (const b of bookingsAfterTestFilter) {
    const key = b.booking_group_id ?? b.id;
    const seats = seatsByBooking.get(key);
    if (seats) seats.push(b);
    else seatsByBooking.set(key, [b]);
  }
  const liveEntries = [...seatsByBooking.values()]
    .filter((seats) => !seats.every((s) => isNeverConfirmed(s)))
    .map((seats) => {
      const held = seats.filter((s) => s.status !== 'cancelled');
      return {
        user_id: seats[0].user_id,
        created_at: seats.reduce((m, s) => (s.created_at < m ? s.created_at : m), seats[0].created_at),
        status: held.length === 0 ? 'cancelled' : held[0].status,
        // Paid if any seat was paid for; the amount is the whole booking's.
        payment_status: seats.some((s) => s.payment_status === 'paid') ? 'paid' : seats[0].payment_status,
        amount: seats.reduce((t, s) => t + (s.payment_status === 'paid' ? Number(s.amount ?? 0) : 0), 0),
        package_purchase_id: seats.find((s) => s.package_purchase_id)?.package_purchase_id ?? null,
      };
    });
  const liveReviews = reviews.filter((r) => liveParent(r.user_id) && liveProvider(providerOfActivity.get(r.activity_id) ?? ''));
  const liveEarnings = earnings.filter(
    (e) => includeTest || isLiveEarning({
      vendorIsTest: testProviders.has(String(e.provider_id)), livemode: e.livemode as boolean | null | undefined, flaggedTest: e.is_test as boolean | null | undefined,
    })
  );

  // ---- daily series (Singapore calendar days) -------------------------------
  const sgDate = (d: string) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
  const days: string[] = [];
  // 90 days, so the admin chart can switch between 7 / 14 / 30 / 90 without another request.
  for (let i = 89; i >= 0; i--) days.push(sgDate(iso(i * DAY)));
  const bucket = (rows: { created_at: string }[]) => {
    const m = new Map<string, number>(days.map((d) => [d, 0]));
    for (const r of rows) {
      const d = sgDate(r.created_at);
      if (m.has(d)) m.set(d, (m.get(d) ?? 0) + 1);
    }
    return m;
  };
  const bBookings = bucket(liveEntries);
  const bSignups = bucket(liveParents);
  // For the chart: bookings made by parents vs added by vendors (no parent account), and gross sales taken.
  const bParent = bucket(liveEntries.filter((b) => b.user_id));
  const bManual = bucket(liveEntries.filter((b) => !b.user_id));
  const salesByDay = new Map<string, number>();
  for (const e of liveEarnings) {
    if (e.status === 'refunded') continue;
    const d = sgDate(String(e.created_at));
    salesByDay.set(d, (salesByDay.get(d) ?? 0) + Number(e.gross_cents ?? 0));
  }
  const daily = days.map((d) => ({
    date: d,
    bookings: bParent.get(d) ?? 0,
    manual: bManual.get(d) ?? 0,
    signups: bSignups.get(d) ?? 0,
    sales: salesByDay.get(d) ?? 0,
  }));
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
  // Manual roster entries (no parent account) are a vendor's own records, not a parent booking, so
  // they count neither as "a parent who booked" nor as a vendor having been booked.
  const parentBookings = liveBookings.filter((b) => !isManualBooking(b));
  const bookedProviders = new Set(
    parentBookings.map((b) => providerOfSession.get(b.session_id)).filter((p): p is string => !!p)
  );
  const growth = {
    newParents7: since(liveParents, 7),
    newParents30: since(liveParents, 30),
    newVendors30: since(liveProviders, 30),
    parentsWhoBooked: new Set(parentBookings.map((b) => b.user_id)).size,
    // A vendor that has gone live (active + a published class) and received a booking.
    activatedVendors: liveProviders.filter(
      (p) => p.status === 'active' && publishedByProvider.has(p.id) && bookedProviders.has(p.id)
    ).length,
  };

  // ---- booking health -------------------------------------------------------
  const all30 = liveEntries.filter((b) => b.created_at >= iso(30 * DAY));
  const b30 = all30;
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
  // Every live booking falls in exactly one of these, so the three add up to "Bookings (all)":
  // manual = added by a vendor with no parent account (guest roster entry); paid = the parent
  // paid online; the rest are free classes, package credits and refunded bookings.
  const manualBookings = liveEntries.filter((b) => bookingBucket(b) === 'manual');
  const paidBookings = liveEntries.filter((b) => bookingBucket(b) === 'paid');
  const health = {
    bookingSplit: {
      manual: manualBookings.length,
      paid: paidBookings.length,
      paidAmount: paidBookings.reduce((t, b) => t + Number(b.amount ?? 0), 0),
      other: liveEntries.length - manualBookings.length - paidBookings.length,
    },
    bookings30: all30.length,
    cancelled30,
    cancellationRate: b30.length ? cancelled30 / b30.length : null,
    waitlisted: liveEntries.filter((b) => b.status === 'waitlisted').length,
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
      bookings: bookings.length - bookingsAfterTestFilter.length,
      sales: earnings.length - liveEarnings.length,
    },
    totals: {
      parents: liveParents.length,
      providers: liveProviders.length,
      activeProviders: liveProviders.filter((p) => p.status === 'active').length,
      bookings: liveEntries.length,
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
