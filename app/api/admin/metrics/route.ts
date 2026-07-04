import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin';
import { createAdminClient } from '@/lib/supabase/admin';

/** Founder KPI snapshot, sourced straight from the Supabase database. */
export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const admin = createAdminClient();
  const head = { count: 'exact' as const, head: true };
  const since14 = new Date(Date.now() - 14 * 864e5).toISOString();

  const [
    parents,
    providers,
    activeProviders,
    bookingsTotal,
    plusSubs,
    growthSubs,
    reviews,
    activities,
    recentBookings,
    recentSignups,
  ] = await Promise.all([
    admin.from('parent_profiles').select('*', head),
    admin.from('providers').select('*', head),
    admin.from('providers').select('*', head).eq('status', 'active'),
    admin.from('bookings').select('*', head),
    admin.from('customer_subscriptions').select('*', head).eq('plan', 'plus'),
    admin.from('subscriptions').select('*', head).eq('plan', 'growth'),
    admin.from('reviews').select('*', head),
    admin.from('activities').select('*', head),
    admin.from('bookings').select('created_at').gte('created_at', since14),
    admin.from('parent_profiles').select('created_at').gte('created_at', since14),
  ]);

  // Bucket the last 14 days by Singapore calendar date.
  const sgDate = (iso: string) =>
    new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
  const days: string[] = [];
  for (let i = 13; i >= 0; i--) {
    days.push(sgDate(new Date(Date.now() - i * 864e5).toISOString()));
  }
  const bucket = (rows: { created_at: string }[] | null) => {
    const m = new Map<string, number>(days.map((d) => [d, 0]));
    for (const r of rows ?? []) {
      const d = sgDate(r.created_at);
      if (m.has(d)) m.set(d, (m.get(d) ?? 0) + 1);
    }
    return m;
  };
  const bBookings = bucket(recentBookings.data);
  const bSignups = bucket(recentSignups.data);
  const daily = days.map((d) => ({
    date: d,
    bookings: bBookings.get(d) ?? 0,
    signups: bSignups.get(d) ?? 0,
  }));
  const today = days[days.length - 1];
  const last7 = days.slice(-7);
  const sum = (m: Map<string, number>, keys: string[]) =>
    keys.reduce((n, k) => n + (m.get(k) ?? 0), 0);

  return NextResponse.json({
    totals: {
      parents: parents.count ?? 0,
      providers: providers.count ?? 0,
      activeProviders: activeProviders.count ?? 0,
      bookings: bookingsTotal.count ?? 0,
      plusSubscribers: plusSubs.count ?? 0,
      growthSubscribers: growthSubs.count ?? 0,
      reviews: reviews.count ?? 0,
      activities: activities.count ?? 0,
    },
    bookings: { today: bBookings.get(today) ?? 0, last7: sum(bBookings, last7) },
    signups: { today: bSignups.get(today) ?? 0, last7: sum(bSignups, last7) },
    daily,
  });
}
