import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Crown, TrendingUp, Users, CalendarDays, Eye, Star, Repeat } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/auth/AuthProvider';

/**
 * Insights — its own tab rather than a card on the dashboard, since it is the
 * headline feature of the Pro tier, and locked below it.
 *
 * The dashboard's version showed a hardcoded "1 – 2 yrs / Saturday / Suntec
 * City" for every vendor. Everything here is computed from the provider's own
 * bookings.
 */

type Row = { label: string; value: number };

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const ageBand = (min: number, max: number) => {
  const mid = (min + max) / 2;
  if (mid < 12) return '0 – 1 yr';
  if (mid < 24) return '1 – 2 yrs';
  if (mid < 48) return '2 – 4 yrs';
  if (mid < 84) return '4 – 7 yrs';
  return '7 yrs+';
};

const top = (counts: Record<string, number>, n = 3): Row[] =>
  Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([label, value]) => ({ label, value }));

export default function InsightsPage() {
  const { provider, subscription } = useAuth();
  const navigate = useNavigate();
  const plan = subscription?.plan ?? 'free';
  const unlocked = plan === 'pro' || plan === 'premium';

  const [loading, setLoading] = useState(true);
  const [views30, setViews30] = useState<number | null>(null);
  const [bookings30, setBookings30] = useState(0);
  const [topActivities, setTopActivities] = useState<Row[]>([]);
  const [topAges, setTopAges] = useState<Row[]>([]);
  const [topDays, setTopDays] = useState<Row[]>([]);
  const [topTimes, setTopTimes] = useState<Row[]>([]);
  const [topLocations, setTopLocations] = useState<Row[]>([]);
  // QA (vendor): "Insights missing — if there is a trial option, how many
  // convert into package sign ups."
  const [trial, setTrial] = useState<{
    trials: number; converted: number;
    conversion_rate: number | null; median_days_to_convert: number | null;
  } | null>(null);

  useEffect(() => {
    if (!provider || !unlocked) { setLoading(false); return; }
    (async () => {
      const since = new Date(Date.now() - 30 * 864e5).toISOString();

      const { data: acts } = await supabase
        .from('activities')
        .select('id, title, age_min_months, age_max_months, location_id')
        .eq('provider_id', provider.id);
      const byId = new Map((acts ?? []).map((a) => [a.id, a]));

      const { data: locs } = await supabase
        .from('provider_locations')
        .select('id, name')
        .eq('provider_id', provider.id);
      const locName = new Map((locs ?? []).map((l) => [l.id, l.name]));

      const { count: views } = await supabase
        .from('listing_events')
        .select('id', { count: 'exact', head: true })
        .eq('provider_id', provider.id)
        .eq('type', 'listing_view')
        .gte('created_at', since);
      setViews30(views ?? 0);

      const ids = [...byId.keys()];
      if (ids.length) {
        const { data: bks } = await supabase
          .from('bookings')
          .select('id, created_at, status, activity_sessions(starts_at, activity_id)')
          .gte('created_at', since);

        const rows = (bks ?? []).filter((b) => {
          const s = b.activity_sessions as unknown as { activity_id: string } | null;
          return b.status !== 'cancelled' && s && byId.has(s.activity_id);
        });
        setBookings30(rows.length);

        const acc: Record<string, Record<string, number>> = { act: {}, age: {}, day: {}, time: {}, loc: {} };
        for (const b of rows) {
          const s = b.activity_sessions as unknown as { starts_at: string; activity_id: string };
          const a = byId.get(s.activity_id)!;
          acc.act[a.title] = (acc.act[a.title] ?? 0) + 1;
          acc.age[ageBand(a.age_min_months, a.age_max_months)] =
            (acc.age[ageBand(a.age_min_months, a.age_max_months)] ?? 0) + 1;
          // Sessions are stored in UTC; read them back in Singapore time.
          const sgt = new Date(new Date(s.starts_at).toLocaleString('en-US', { timeZone: 'Asia/Singapore' }));
          acc.day[WEEKDAYS[sgt.getDay()]] = (acc.day[WEEKDAYS[sgt.getDay()]] ?? 0) + 1;
          const hhmm = sgt.toLocaleTimeString('en-SG', { hour: 'numeric', minute: '2-digit' });
          acc.time[hhmm] = (acc.time[hhmm] ?? 0) + 1;
          const ln = a.location_id ? locName.get(a.location_id) : null;
          if (ln) acc.loc[ln] = (acc.loc[ln] ?? 0) + 1;
        }
        setTopActivities(top(acc.act));
        setTopAges(top(acc.age));
        setTopDays(top(acc.day));
        setTopTimes(top(acc.time));
        setTopLocations(top(acc.loc));
      }
      const { data: conv } = await supabase.rpc('provider_trial_conversion', {
        p_provider: provider.id,
        p_days: 90,
      });
      setTrial((conv?.[0] as typeof trial) ?? null);

      setLoading(false);
    })();
  }, [provider, unlocked]);

  if (!unlocked) {
    return (
      <div className="p-8">
        <h1 className="text-2xl font-bold text-gray-900">Insights</h1>
        <p className="mt-1 text-sm text-gray-500">See what's driving your bookings.</p>
        <div className="mt-6 rounded-xl border border-dashed border-purple-300 bg-purple-50/40 p-10 text-center">
          <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-purple-300 text-purple-800">
            <Crown className="h-7 w-7" />
          </span>
          <h2 className="mt-4 text-xl font-bold text-gray-900">Insights is a Pro feature</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-gray-600">
            Find out which activities convert, which age groups book most, and the days,
            times and locations parents actually choose.
          </p>
          <Button onClick={() => navigate('/plans')} className="mt-5 gradient-primary text-white">
            Go Pro
          </Button>
        </div>
      </div>
    );
  }

  const conversion = views30 && views30 > 0 ? Math.round((bookings30 / views30) * 100) : null;

  const Panel = ({ title, icon: Icon, rows, empty }: { title: string; icon: typeof Star; rows: Row[]; empty: string }) => (
    <div className="rounded-xl border border-gray-200 bg-white p-5">
      <h3 className="mb-3 flex items-center gap-2 font-semibold text-gray-900">
        <Icon className="h-4 w-4 text-purple-600" /> {title}
      </h3>
      {rows.length === 0 ? (
        <p className="text-sm text-gray-400">{empty}</p>
      ) : (
        <div className="space-y-2">
          {rows.map((r, i) => (
            <div key={r.label} className="flex items-center gap-3">
              <span className={cn('w-5 text-xs font-bold', i === 0 ? 'text-purple-600' : 'text-gray-400')}>
                {i + 1}
              </span>
              <span className="flex-1 truncate text-sm text-gray-800">{r.label}</span>
              <span className="text-sm font-semibold text-gray-900">{r.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold text-gray-900">Insights</h1>
      <p className="mt-1 text-sm text-gray-500">Based on your bookings over the last 30 days.</p>

      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        {[
          { label: 'Listing views', value: views30 ?? '—', icon: Eye },
          { label: 'Bookings', value: bookings30, icon: CalendarDays },
          { label: 'Conversion', value: conversion != null ? `${conversion}%` : '—', icon: TrendingUp },
        ].map((s) => (
          <div key={s.label} className="rounded-xl border border-gray-200 bg-white p-5">
            <div className="flex items-center gap-2 text-xs font-medium text-gray-500">
              <s.icon className="h-4 w-4 text-purple-600" /> {s.label}
            </div>
            <div className="mt-2 text-2xl font-bold text-gray-900">{loading ? '…' : s.value}</div>
          </div>
        ))}
      </div>

      {/* Trials look further back than 30 days: a parent who tries a class
          rarely buys a pack the same month. */}
      <div className="mt-4 rounded-xl border border-gray-200 bg-white p-5">
        <h3 className="mb-1 flex items-center gap-2 font-semibold text-gray-900">
          <Repeat className="h-4 w-4 text-purple-600" /> Trial → package conversion
        </h3>
        <p className="mb-4 text-xs text-gray-500">
          Parents whose first booking with you was paid for on its own, and how many went on to buy a
          class pack. Last 90 days.
        </p>
        {loading ? (
          <p className="text-sm text-gray-400">…</p>
        ) : !trial || trial.trials === 0 ? (
          <p className="text-sm text-gray-400">No first-time bookings in the last 90 days yet.</p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-4">
            {[
              { label: 'Trials', value: String(trial.trials) },
              { label: 'Bought a pack', value: String(trial.converted) },
              { label: 'Conversion', value: trial.conversion_rate != null ? `${trial.conversion_rate}%` : '—' },
              {
                label: 'Typical time to buy',
                value: trial.median_days_to_convert != null ? `${trial.median_days_to_convert} days` : '—',
              },
            ].map((s) => (
              <div key={s.label}>
                <div className="text-xs font-medium text-gray-500">{s.label}</div>
                <div className="mt-1 text-2xl font-bold text-gray-900">{s.value}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Panel title="Top activities" icon={Star} rows={topActivities} empty="No bookings in the last 30 days." />
        <Panel title="Top age groups" icon={Users} rows={topAges} empty="No bookings yet." />
        <Panel title="Most popular days" icon={CalendarDays} rows={topDays} empty="No bookings yet." />
        <Panel title="Most popular times" icon={TrendingUp} rows={topTimes} empty="No bookings yet." />
      </div>

      {topLocations.length > 0 && (
        <div className="mt-4">
          <Panel title="Most popular locations" icon={Users} rows={topLocations} empty="" />
        </div>
      )}
    </div>
  );
}
