import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  addDays, addMonths, differenceInCalendarDays, eachDayOfInterval, endOfDay, endOfMonth, endOfWeek, format,
  isSameDay, isSameMonth, isToday, startOfDay, startOfMonth, startOfWeek,
} from 'date-fns';
import { ChevronLeft, ChevronRight, MapPin, CalendarRange, Users, User as UserIcon, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { supabase } from '@/lib/supabase';
import { apiGet } from '@/lib/api';
import { useAuth } from '@/auth/AuthProvider';

const WEEK_OPTS = { weekStartsOn: 1 as const };

const sgTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-SG', { timeZone: 'Asia/Singapore', hour: 'numeric', minute: '2-digit' });

type EnrichedSession = {
  id: string;
  activity_id: string;
  title: string;
  starts_at: string;
  ends_at: string;
  capacity: number | null;
  booked: number;
  locationName: string | null;
  teacherName: string | null;
  studio: string | null;
  fromWix: boolean;
};

export default function SchedulePage() {
  const { provider } = useAuth();
  const navigate = useNavigate();

  const [view, setView] = useState<'week' | 'month'>('week');
  const [cursor, setCursor] = useState(new Date());
  const [fActivity, setFActivity] = useState('');
  const [fLocation, setFLocation] = useState('');

  const [activities, setActivities] = useState<{ id: string; title: string; location_id: string | null; wix_service_id: string | null }[]>([]);
  const [locations, setLocations] = useState<{ id: string; name: string }[]>([]);
  const [sessions, setSessions] = useState<EnrichedSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [wixError, setWixError] = useState<string | null>(null);
  const [wixSyncedAt, setWixSyncedAt] = useState<Date | null>(null);
  const [syncNonce, setSyncNonce] = useState(0);

  // This provider's activities + locations, once — everything else filters
  // against these rather than re-fetching them per view.
  useEffect(() => {
    if (!provider) return;
    (async () => {
      const [{ data: acts }, { data: locs }] = await Promise.all([
        supabase.from('activities').select('id, title, location_id, wix_service_id').eq('provider_id', provider.id),
        supabase.from('provider_locations').select('id, name').eq('provider_id', provider.id),
      ]);
      setActivities(acts ?? []);
      setLocations(locs ?? []);
    })();
  }, [provider]);

  const wixLinkedIds = useMemo(() => activities.filter((a) => a.wix_service_id).map((a) => a.id), [activities]);

  // "week" is a rolling 7-day window from cursor, not the Mon-Sun calendar
  // week containing it — on a Friday/Saturday/Sunday, the calendar-week
  // version left almost nothing upcoming in view by default, even with
  // plenty booked for the days immediately ahead.
  const rangeStart = useMemo(
    () => (view === 'week' ? startOfDay(cursor) : startOfWeek(startOfMonth(cursor), WEEK_OPTS)),
    [view, cursor]
  );
  const rangeEnd = useMemo(
    () => (view === 'week' ? endOfDay(addDays(cursor, 6)) : endOfWeek(endOfMonth(cursor), WEEK_OPTS)),
    [view, cursor]
  );

  useEffect(() => {
    if (!provider || activities.length === 0) { setLoading(false); return; }
    (async () => {
      setLoading(true);
      setWixError(null);

      // Refresh live Wix availability for every Wix-linked activity in view
      // first — /api/wix/slots upserts a local activity_sessions copy of
      // whatever it fetches, so the DB query right after this picks up
      // both site-native and Wix-sourced sessions in one place. A slow or
      // failing Wix call never blocks the site's own sessions from showing.
      if (wixLinkedIds.length > 0) {
        const days = Math.min(Math.max(differenceInCalendarDays(rangeEnd, new Date()) + 1, 7), 60);
        const results = await Promise.allSettled(
          wixLinkedIds.map((id) => apiGet(`/api/wix/slots?activityId=${id}&days=${days}`))
        );
        const failed = results.some((r) => r.status === 'rejected');
        if (failed) setWixError('Some Wix availability could not be refreshed — showing the last saved copy.');
        setWixSyncedAt(new Date());
      }

      const activityMap = new Map(activities.map((a) => [a.id, a]));
      const locationMap = new Map(locations.map((l) => [l.id, l.name]));
      const { data: sess } = await supabase
        .from('activity_sessions')
        .select('id, activity_id, starts_at, ends_at, capacity, location_id, teacher_name, studio, wix_slot_key, wix_remaining_capacity')
        .in('activity_id', activities.map((a) => a.id))
        .neq('status', 'cancelled')
        .gte('starts_at', rangeStart.toISOString())
        .lte('starts_at', rangeEnd.toISOString())
        .order('starts_at');
      const rows = sess ?? [];
      const counts: Record<string, number> = {};
      if (rows.length) {
        const { data: bks } = await supabase
          .from('bookings')
          .select('session_id, status')
          .in('session_id', rows.map((s) => s.id));
        (bks ?? []).forEach((b) => {
          if (b.status !== 'cancelled') counts[b.session_id] = (counts[b.session_id] ?? 0) + 1;
        });
      }
      setSessions(
        rows.map((s) => {
          const act = activityMap.get(s.activity_id);
          const locId = s.location_id ?? act?.location_id ?? null;
          const fromWix = !!s.wix_slot_key;
          // A Wix-sourced slot can be booked directly on Wix's own site, so
          // our local `bookings` count alone would under-report it — Wix's
          // remaining-capacity figure (kept fresh by the sync above) catches
          // that case. But the reverse also happens: Wix's own availability
          // endpoint has been observed to lag behind a booking that was just
          // created through Wix's own booking API (confirmed, real, but not
          // yet reflected in remainingCapacity) — trusting it exclusively
          // then hides a real BabyBrain-made booking. Taking the higher of
          // the two numbers covers both directions instead of picking one.
          const wixDerived =
            fromWix && s.wix_remaining_capacity != null && s.capacity != null
              ? Math.max(0, s.capacity - s.wix_remaining_capacity)
              : 0;
          const booked = Math.max(wixDerived, counts[s.id] ?? 0);
          return {
            id: s.id,
            activity_id: s.activity_id,
            title: act?.title ?? 'Activity',
            starts_at: s.starts_at,
            ends_at: s.ends_at,
            capacity: s.capacity,
            booked,
            locationName: locId ? locationMap.get(locId) ?? null : null,
            teacherName: s.teacher_name,
            studio: s.studio,
            fromWix,
          };
        })
      );
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, activities, locations, rangeStart, rangeEnd, syncNonce]);

  const filtered = useMemo(
    () =>
      sessions.filter(
        (s) =>
          (!fActivity || s.activity_id === fActivity) &&
          (!fLocation || locations.find((l) => l.id === fLocation)?.name === s.locationName)
      ),
    [sessions, fActivity, fLocation, locations]
  );

  const goToday = () => setCursor(new Date());
  const goPrev = () => setCursor((c) => (view === 'week' ? addDays(c, -7) : addMonths(c, -1)));
  const goNext = () => setCursor((c) => (view === 'week' ? addDays(c, 7) : addMonths(c, 1)));
  const openDay = (d: Date) => { setCursor(d); setView('week'); };

  const rangeLabel =
    view === 'week'
      ? `${format(rangeStart, 'd MMM')} – ${format(addDays(cursor, 6), 'd MMM yyyy')}`
      : format(cursor, 'MMMM yyyy');

  const weekDays = useMemo(
    () => eachDayOfInterval({ start: startOfDay(cursor), end: addDays(startOfDay(cursor), 6) }),
    [cursor]
  );
  const monthDays = useMemo(() => eachDayOfInterval({ start: rangeStart, end: rangeEnd }), [rangeStart, rangeEnd]);

  const sessionsFor = (d: Date) => filtered.filter((s) => isSameDay(new Date(s.starts_at), d));

  return (
    <div className="relative">
      <div className="flex items-center justify-between px-8 py-5">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Schedule</h1>
          <p className="text-sm text-gray-500 mt-1">
            Every upcoming session — site bookings and live Wix availability, together.
            {wixLinkedIds.length > 0 && wixSyncedAt && (
              <> Wix last synced {wixSyncedAt.toLocaleTimeString('en-SG', { timeZone: 'Asia/Singapore' })}.</>
            )}
          </p>
        </div>
        {wixLinkedIds.length > 0 && (
          <button
            onClick={() => setSyncNonce((n) => n + 1)}
            disabled={loading}
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-white border border-gray-200 rounded-xl text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh Wix
          </button>
        )}
      </div>

      <div className="px-8 pb-8">
        {wixError && (
          <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">{wixError}</div>
        )}

        {/* Controls */}
        <div className="mb-6 flex flex-wrap items-center gap-3">
          <div className="inline-flex rounded-xl border border-gray-200 bg-white p-1">
            <button
              onClick={goPrev}
              aria-label={view === 'week' ? 'Previous week' : 'Previous month'}
              className="grid h-8 w-8 place-items-center rounded-lg text-gray-500 hover:bg-gray-100"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button onClick={goToday} className="px-3 h-8 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg">
              Today
            </button>
            <button
              onClick={goNext}
              aria-label={view === 'week' ? 'Next week' : 'Next month'}
              className="grid h-8 w-8 place-items-center rounded-lg text-gray-500 hover:bg-gray-100"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          <div className="text-sm font-semibold text-gray-900">{rangeLabel}</div>

          <div className="ml-auto flex flex-wrap items-center gap-3">
            <div className="inline-flex items-center gap-2 px-4 py-2.5 bg-white border border-gray-200 rounded-xl text-sm text-gray-700">
              <CalendarRange className="w-4 h-4 text-[#C90044]" />
              <select value={fActivity} onChange={(e) => setFActivity(e.target.value)} className="bg-transparent font-medium focus:outline-none">
                <option value="">All activities</option>
                {activities.map((a) => (
                  <option key={a.id} value={a.id}>{a.title}</option>
                ))}
              </select>
            </div>
            <div className="inline-flex items-center gap-2 px-4 py-2.5 bg-white border border-gray-200 rounded-xl text-sm text-gray-700">
              <MapPin className="w-4 h-4 text-[#C90044]" />
              <select value={fLocation} onChange={(e) => setFLocation(e.target.value)} className="bg-transparent font-medium focus:outline-none">
                <option value="">All locations</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </select>
            </div>
            <div className="inline-flex rounded-xl border border-gray-200 bg-white p-1">
              {(['week', 'month'] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  className={cn(
                    'px-3 h-8 text-sm font-medium rounded-lg capitalize transition-colors',
                    view === v ? 'bg-pink-50 text-[#C90044]' : 'text-gray-600 hover:bg-gray-100'
                  )}
                >
                  {v}
                </button>
              ))}
            </div>
          </div>
        </div>

        {loading && <div className="text-sm text-gray-400">Loading…</div>}

        {!loading && activities.length === 0 && (
          <div className="rounded-xl border border-gray-200 bg-white p-8 text-center">
            <p className="text-sm text-gray-500 mb-3">You don't have any activities yet, so there's nothing to schedule.</p>
            <button onClick={() => navigate('/activities')} className="text-sm font-medium text-[#C90044] hover:underline">
              Create an activity
            </button>
          </div>
        )}

        {!loading && activities.length > 0 && view === 'week' && (
          <div className="grid grid-cols-7 gap-3">
            {weekDays.map((d) => {
              const daySessions = sessionsFor(d);
              return (
                <div key={d.toISOString()} className="min-h-[240px] rounded-xl border border-gray-200 bg-white p-3">
                  <div className="mb-2 flex items-baseline justify-between">
                    <span className="text-xs font-medium text-gray-500">{format(d, 'EEE')}</span>
                    <span
                      className={cn(
                        'text-sm font-semibold',
                        isToday(d) ? 'grid h-6 w-6 place-items-center rounded-full bg-[#C90044] text-white' : 'text-gray-900'
                      )}
                    >
                      {format(d, 'd')}
                    </span>
                  </div>
                  <div className="space-y-2">
                    {daySessions.map((s) => (
                      <SessionCard key={s.id} s={s} onClick={() => navigate(`/bookings?session=${s.id}`)} />
                    ))}
                    {daySessions.length === 0 && <div className="text-xs text-gray-300">No sessions</div>}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {!loading && activities.length > 0 && view === 'month' && (
          <div>
            <div className="grid grid-cols-7 gap-px overflow-hidden rounded-t-xl border border-b-0 border-gray-200 bg-gray-200">
              {weekDays.map((d) => (
                <div key={d.toISOString()} className="bg-gray-50 px-3 py-2 text-xs font-medium text-gray-500">
                  {format(d, 'EEE')}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-px overflow-hidden rounded-b-xl border border-gray-200 bg-gray-200">
              {monthDays.map((d) => {
                const daySessions = sessionsFor(d);
                const visible = daySessions.slice(0, 3);
                const overflow = daySessions.length - visible.length;
                return (
                  <button
                    key={d.toISOString()}
                    onClick={() => openDay(d)}
                    className={cn(
                      'min-h-[110px] bg-white p-2 text-left align-top hover:bg-gray-50 transition-colors',
                      !isSameMonth(d, cursor) && 'bg-gray-50/60'
                    )}
                  >
                    <span
                      className={cn(
                        'inline-grid h-6 w-6 place-items-center rounded-full text-xs font-semibold',
                        isToday(d) ? 'bg-[#C90044] text-white' : !isSameMonth(d, cursor) ? 'text-gray-300' : 'text-gray-900'
                      )}
                    >
                      {format(d, 'd')}
                    </span>
                    <div className="mt-1.5 space-y-1">
                      {visible.map((s) => (
                        <div
                          key={s.id}
                          className={cn(
                            'truncate rounded px-1.5 py-0.5 text-[11px] font-medium',
                            s.fromWix ? 'bg-purple-50 text-purple-700' : 'bg-pink-50 text-[#C90044]'
                          )}
                        >
                          {sgTime(s.starts_at)} {s.title}
                        </div>
                      ))}
                      {overflow > 0 && <div className="px-1.5 text-[11px] text-gray-400">+{overflow} more</div>}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SessionCard({ s, onClick }: { s: EnrichedSession; onClick: () => void }) {
  const full = s.capacity != null && s.booked >= s.capacity;
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full rounded-lg border px-2.5 py-2 text-left transition-colors',
        s.fromWix ? 'border-purple-100 bg-purple-50/60 hover:bg-purple-50' : 'border-gray-100 bg-pink-50/60 hover:bg-pink-50'
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-semibold text-gray-900">{sgTime(s.starts_at)} – {sgTime(s.ends_at)}</div>
        {s.fromWix && (
          <span className="shrink-0 rounded-full bg-purple-100 px-1.5 py-0.5 text-[10px] font-semibold text-purple-700">Wix</span>
        )}
      </div>
      <div className="truncate text-xs text-gray-700">{s.title}</div>
      {s.locationName && (
        <div className="mt-0.5 flex items-center gap-1 text-[11px] text-gray-500">
          <MapPin className="h-3 w-3 flex-shrink-0" /> <span className="truncate">{s.locationName}</span>
        </div>
      )}
      {(s.teacherName || s.studio) && (
        <div className="mt-0.5 flex items-center gap-1 text-[11px] text-purple-700">
          <UserIcon className="h-3 w-3 flex-shrink-0" />
          <span className="truncate">{[s.teacherName, s.studio].filter(Boolean).join(' · ')}</span>
        </div>
      )}
      <div className="mt-1 flex items-center gap-1 text-[11px]">
        <Users className="h-3 w-3 text-gray-400" />
        <span className={cn(full ? 'font-medium text-red-600' : 'text-gray-500')}>
          {s.booked}{s.capacity != null ? `/${s.capacity}` : ''} {full ? '· Full' : ''}
        </span>
      </div>
    </button>
  );
}
