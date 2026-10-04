import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  addDays, addMonths, differenceInCalendarDays, eachDayOfInterval, endOfDay, endOfMonth, endOfWeek, format,
  isSameDay, isSameMonth, isToday, startOfDay, startOfMonth, startOfWeek,
} from 'date-fns';
import { ChevronLeft, ChevronRight, ChevronDown, MapPin, CalendarRange, RefreshCw, Users, User as UserIcon, CalendarX2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { supabase } from '@/lib/supabase';
import { apiGet, apiPost } from '@/lib/api';
import { useAuth } from '@/auth/AuthProvider';
import { useProviderQuery } from '@/lib/useProviderQuery';
import { computeWixAwareCapacity, isHeldBookingStatus } from '@/lib/wixCapacity';
import { ScheduleWeekSkeleton, RefreshBar } from '@/components/Skeletons';
import { SelectField, Opt } from '@/components/ui/select-field';
import DayDetailDialog, { type OriginRect } from '@/components/DayDetailDialog';

type ScheduleActivity = {
  id: string; title: string; location_id: string | null;
  wix_service_id: string | null; wix_service_type: string | null;
  /** Wix Events: one event, or a recurring series folded into one activity. */
  wix_event_id: string | null; wix_series_id: string | null;
};
type ScheduleLocation = { id: string; name: string };
const NO_ACTIVITIES: ScheduleActivity[] = [];
const NO_LOCATIONS: ScheduleLocation[] = [];
const NO_SESSIONS: EnrichedSession[] = [];

const WEEK_OPTS = { weekStartsOn: 1 as const };

const sgTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-SG', { timeZone: 'Asia/Singapore', hour: 'numeric', minute: '2-digit' });

/** A consistent colour per activity across the whole calendar — the same
 *  class reads as "the same class" whichever day/slot it appears in,
 *  instead of every card defaulting to the same one or two brand tints.
 *  Picked deterministically from the activity id, so it never needs its own
 *  stored column and never reshuffles between loads. A paused session
 *  always overrides to amber — that's the one state worth breaking the
 *  pattern for, since it means "don't book this" regardless of which class
 *  it is. */
type SlotAccent = { bar: string };
const ACTIVITY_ACCENTS: SlotAccent[] = [
  { bar: 'bg-pink-400' },
  { bar: 'bg-orange-400' },
  { bar: 'bg-purple-400' },
  { bar: 'bg-green-400' },
  { bar: 'bg-blue-400' },
];
const PAUSED_ACCENT: SlotAccent = { bar: 'bg-amber-400' };

function accentFor(s: EnrichedSession): SlotAccent {
  if (s.bookingsPaused) return PAUSED_ACCENT;
  let hash = 0;
  for (let i = 0; i < s.activity_id.length; i++) hash = (hash * 31 + s.activity_id.charCodeAt(i)) | 0;
  return ACTIVITY_ACCENTS[Math.abs(hash) % ACTIVITY_ACCENTS.length];
}

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
  isCourse: boolean;
  // Wix-linked weekly CLASS only: seats held past the (immutable, Wix-mirrored)
  // capacity — promoted + paid from the waitlist (00108). The cell shows
  // "n/n +x" instead of an oversold "n+x/n". 0 for every other session type.
  wixClassOverflow: number;
  // Per-session pause (00091) — closes just this slot to new parent bookings,
  // independent of the activity-wide switch.
  bookingsPaused: boolean;
};

export default function SchedulePage() {
  const { provider } = useAuth();
  const navigate = useNavigate();

  const [view, setView] = useState<'week' | 'month'>('week');
  const [cursor, setCursor] = useState(new Date());
  const [fActivity, setFActivity] = useState('');
  const [fLocation, setFLocation] = useState('');
  const [dayDetail, setDayDetail] = useState<Date | null>(null);
  const [dayOrigin, setDayOrigin] = useState<OriginRect | null>(null);

  const [wixError, setWixError] = useState<string | null>(null);
  const [wixSyncedAt, setWixSyncedAt] = useState<Date | null>(null);
  const [syncingEvents, setSyncingEvents] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  // This provider's activities + locations — near-static for a session, so
  // stale-while-revalidate cached: revisiting Schedule paints the filters
  // instantly instead of re-running these two queries.
  const { data: refData, loading: refLoading, refreshing: refsRefreshing } = useProviderQuery<{
    activities: ScheduleActivity[];
    locations: ScheduleLocation[];
  }>(
    provider ? `schedule-refs:${provider.id}` : null,
    async () => {
      const [{ data: acts }, { data: locs }] = await Promise.all([
        supabase.from('activities').select('id, title, location_id, wix_service_id, wix_service_type, wix_event_id, wix_series_id').eq('provider_id', provider!.id),
        supabase.from('provider_locations').select('id, name').eq('provider_id', provider!.id),
      ]);
      return { activities: (acts ?? []) as ScheduleActivity[], locations: (locs ?? []) as ScheduleLocation[] };
    },
  );
  const activities = refData?.activities ?? NO_ACTIVITIES;
  const locations = refData?.locations ?? NO_LOCATIONS;

  const wixLinkedIds = useMemo(() => activities.filter((a) => a.wix_service_id).map((a) => a.id), [activities]);
  // A vendor on Wix Events only (no Wix Bookings services) has nothing in `wixLinkedIds`, but still needs a way
  // to pull what changed on Wix - and what a parent just booked - without waiting for the background job.
  const hasWixEvents = useMemo(() => activities.some((a) => a.wix_event_id || a.wix_series_id), [activities]);
  const canSyncWix = wixLinkedIds.length > 0 || hasWixEvents;

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

  // Sessions used to be a raw fetch-on-mount effect, deliberately uncached —
  // live Wix availability has to be trusted. But that meant leaving the
  // Schedule tab and coming straight back (or the app losing focus for a
  // minute) re-ran the whole thing from a blank page every time: a full
  // skeleton, a Wix round-trip per linked activity, two Supabase queries —
  // real "hustle" for a page that mostly looks the same second to second.
  // Routing it through the same stale-while-revalidate cache the reference
  // data already uses (`useProviderQuery`, `lib/queryCache.ts`) fixes that
  // without weakening the freshness guarantee: a cached page still repaints
  // instantly, but every read is *always* followed by a live refetch that
  // replaces it — a stale value is only ever shown a beat early, never
  // trusted as final. The cache's own 10-minute cap means a longer absence
  // just falls back to today's cold-load skeleton, no separate "please
  // refresh" prompt needed.
  const sessionsKey = provider && activities.length > 0
    ? `schedule-sessions:${provider.id}:${rangeStart.toISOString()}:${rangeEnd.toISOString()}`
    : null;
  const { data: sessionsData, loading, refreshing: sessionsRefreshing, refetch: refetchSessions } = useProviderQuery<EnrichedSession[]>(
    sessionsKey,
    async () => {
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
        .select('id, activity_id, starts_at, ends_at, capacity, location_id, teacher_name, studio, bookings_paused, wix_slot_key, wix_remaining_capacity')
        .in('activity_id', activities.map((a) => a.id))
        .neq('status', 'cancelled')
        // A COURSE enrolment's anchor row spans the whole run — it's not a
        // dated occurrence and would render as one giant session on its
        // start day. The course's real per-week occurrences are still here.
        //
        // `.not(col, 'like', pattern)` alone is NOT the right way to exclude
        // it: SQL's three-valued logic makes `NOT (NULL LIKE pattern)`
        // evaluate to NULL, not TRUE, so a plain `.not('wix_slot_key',
        // 'like', 'wixcourse:%')` silently dropped every row whose
        // wix_slot_key is NULL — which is every site-native session and
        // every Wix-Events-mirrored one, i.e. most vendors' entire calendar.
        // Confirmed live: a demo account with a mix of native sessions and
        // one imported Wix event showed "No sessions" all week despite 8
        // real sessions existing in that range. `.or()` keeps a NULL key
        // explicitly instead of leaving it to the NOT.
        .or('wix_slot_key.is.null,wix_slot_key.not.like.wixcourse:%')
        .gte('starts_at', rangeStart.toISOString())
        .lte('starts_at', rangeEnd.toISOString())
        .order('starts_at');
      const rows = sess ?? [];
      // Held seats only — confirmed / completed / pending (see
      // lib/wixCapacity.ts). Waitlisted rows (incl. a promoted-but-unpaid
      // booking, which stays 'waitlisted' until Stripe confirms) are NOT
      // counted, so the cell reads the same n/n as the Dashboard and
      // Bookings page rather than an inflated n+queue/n.
      const counts: Record<string, number> = {};
      if (rows.length) {
        const { data: bks } = await supabase
          .from('bookings')
          .select('session_id, status')
          .in('session_id', rows.map((s) => s.id));
        (bks ?? []).forEach((b) => {
          if (isHeldBookingStatus(b.status)) counts[b.session_id] = (counts[b.session_id] ?? 0) + 1;
        });
      }
      return rows.map((s) => {
        const act = activityMap.get(s.activity_id);
        const locId = s.location_id ?? act?.location_id ?? null;
        const fromWix = !!s.wix_slot_key;
        // See lib/wixCapacity.ts (00108): the higher of Wix's own filled
        // figure and our held local rows — a Wix-sourced slot can be
        // booked directly on Wix's own site, so the local count alone
        // would under-report it; the reverse also happens (Wix's own
        // availability endpoint has been observed to lag a booking just
        // made through BabyBrain), so this always takes the higher number
        // rather than trusting either side exclusively.
        const { booked, overflow: wixClassOverflow } = computeWixAwareCapacity({
          wixSlotKey: s.wix_slot_key,
          wixRemainingCapacity: s.wix_remaining_capacity,
          capacity: s.capacity,
          wixServiceType: act?.wix_service_type,
          localHeldCount: counts[s.id] ?? 0,
        });
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
          isCourse: act?.wix_service_type === 'COURSE',
          wixClassOverflow,
          bookingsPaused: !!s.bookings_paused,
        };
      });
    },
  );
  const sessions = sessionsData ?? NO_SESSIONS;

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
  // Open the day popup with the clicked number's screen rect, so it can morph
  // out of it. `el` is the date-number element (week view) or the cell's
  // number span (month view).
  const openDay = (d: Date, el: Element | null) => {
    if (el) {
      const r = el.getBoundingClientRect();
      setDayOrigin({ left: r.left, top: r.top, width: r.width, height: r.height, radius: Math.min(r.width, r.height) / 2 });
    } else {
      setDayOrigin(null);
    }
    setDayDetail(d);
  };

  const rangeLabel =
    view === 'week'
      ? `${format(rangeStart, 'd MMM')} – ${format(addDays(cursor, 6), 'd MMM yyyy')}`
      : format(cursor, 'MMMM yyyy');

  const weekDays = useMemo(
    () => eachDayOfInterval({ start: startOfDay(cursor), end: addDays(startOfDay(cursor), 6) }),
    [cursor]
  );
  const monthDays = useMemo(() => eachDayOfInterval({ start: rangeStart, end: rangeEnd }), [rangeStart, rangeEnd]);

  // Sessions that start together are shown as one time slot with the sessions
  // listed under it (parallel classes), instead of unrelated-looking cards.
  const groupByStart = <T extends { starts_at: string }>(list: T[]) => {
    const groups: { key: string; items: T[] }[] = [];
    for (const item of list) {
      const last = groups[groups.length - 1];
      if (last && last.key === item.starts_at) last.items.push(item);
      else groups.push({ key: item.starts_at, items: [item] });
    }
    return groups;
  };

  const sessionsFor = (d: Date) => filtered.filter((s) => isSameDay(new Date(s.starts_at), d));

  // Cold load: either the reference data or the sessions are still in flight
  // and there's nothing to show yet. A background revalidate never sets this.
  const busy = refLoading || loading;

  /** "Sync with Wix": for Wix Events, run the full per-vendor sync first (dates, series, orders read back from
   *  Wix); then reload the sessions, which also re-reads live Wix Bookings availability and the booked counts. */
  async function syncWix() {
    if (!provider) return;
    setSyncError(null);
    if (hasWixEvents) {
      setSyncingEvents(true);
      try {
        await apiPost('/api/vendor/wix-events-sync', { provider_id: provider.id, full: true });
        setWixSyncedAt(new Date());
      } catch (e) {
        setSyncError(e instanceof Error && e.message ? `Could not sync Wix events: ${e.message}` : 'Could not sync Wix events. Please try again.');
      }
      setSyncingEvents(false);
    }
    refetchSessions();
  }
  const syncDisabled = loading || sessionsRefreshing || syncingEvents;
  const syncSpinning = loading || sessionsRefreshing || syncingEvents;

  return (
    <div className="relative">
      {(refsRefreshing || sessionsRefreshing) && <RefreshBar />}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-5 sm:px-8">
        <div className="w-full text-center sm:w-auto sm:text-left">
          <h1 className="text-2xl font-bold text-gray-900">Schedule</h1>
          <p className="text-sm text-gray-500 mt-1">
            Every upcoming session{provider?.wix_site_id ? ' — site bookings and live Wix availability, together' : ', all in one place'}.
            {canSyncWix && wixSyncedAt && (
              <> Wix last synced {wixSyncedAt.toLocaleTimeString('en-SG', { timeZone: 'Asia/Singapore' })}.</>
            )}
          </p>
        </div>
        {canSyncWix && (
          <button
            onClick={() => void syncWix()}
            disabled={syncDisabled}
            className="hidden items-center gap-2 px-4 py-2.5 bg-white border border-gray-200 rounded-xl text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 sm:inline-flex"
          >
            <RefreshCw className={cn('h-4 w-4', syncSpinning && 'animate-spin')} />
            {syncingEvents ? 'Syncing…' : 'Sync with Wix'}
          </button>
        )}
      </div>

      <div className="px-4 pb-8 sm:px-8">
        {(wixError || syncError) && (
          <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">{syncError ?? wixError}</div>
        )}

        {/* Controls. Mobile stacks them one per row, centred, in the order
            Sync with Wix → activities → locations → week/month → date nav →
            date range. Desktop keeps the original single-row layout via
            sm:order overrides. */}
        <div className="mb-6 flex flex-col items-center gap-3 sm:flex-row sm:flex-wrap sm:items-center">
          {/* Sync with Wix — mobile only; desktop keeps it in the page header */}
          {canSyncWix && (
            <button
              onClick={() => void syncWix()}
              disabled={syncDisabled}
              className="flex w-full items-center justify-center gap-2 px-4 py-2.5 bg-white border border-gray-200 rounded-xl text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 sm:hidden"
            >
              <RefreshCw className={cn('h-4 w-4', syncSpinning && 'animate-spin')} />
              {syncingEvents ? 'Syncing…' : 'Sync with Wix'}
            </button>
          )}

          {/* All activities */}
          <div className="flex w-full items-center gap-2 px-4 py-2.5 bg-white border border-gray-200 rounded-xl text-sm text-gray-700 sm:order-3 sm:ml-auto sm:w-auto">
            <CalendarRange className="w-4 h-4 shrink-0 text-[#FA4D8D]" />
            <SelectField bare value={fActivity} onChange={setFActivity} aria-label="Filter by activity" className="min-w-0 flex-1 font-medium sm:flex-none">
              <Opt value="">All activities</Opt>
              {activities.map((a) => (
                <Opt key={a.id} value={a.id}>{a.title}</Opt>
              ))}
            </SelectField>
          </div>

          {/* All locations */}
          <div className="flex w-full items-center gap-2 px-4 py-2.5 bg-white border border-gray-200 rounded-xl text-sm text-gray-700 sm:order-4 sm:w-auto">
            <MapPin className="w-4 h-4 shrink-0 text-[#FA4D8D]" />
            <SelectField bare value={fLocation} onChange={setFLocation} aria-label="Filter by location" className="min-w-0 flex-1 font-medium sm:flex-none">
              <Opt value="">All locations</Opt>
              {locations.map((l) => (
                <Opt key={l.id} value={l.id}>{l.name}</Opt>
              ))}
            </SelectField>
          </div>

          {/* Week / Month */}
          <div className="flex w-full rounded-xl border border-gray-200 bg-white p-1 sm:order-5 sm:inline-flex sm:w-auto">
            {(['week', 'month'] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={cn(
                  'h-8 flex-1 px-3 text-sm font-medium rounded-lg capitalize transition-colors sm:flex-none',
                  view === v ? 'bg-pink-50 text-[#FA4D8D]' : 'text-gray-600 hover:bg-gray-100'
                )}
              >
                {v}
              </button>
            ))}
          </div>

          {/* Date nav — 80% of the row on mobile, centred; auto on desktop */}
          <div className="flex w-4/5 justify-center rounded-xl border border-gray-200 bg-white p-1 sm:order-1 sm:inline-flex sm:w-auto">
            <button
              onClick={goPrev}
              aria-label={view === 'week' ? 'Previous week' : 'Previous month'}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-gray-500 hover:bg-gray-100"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button onClick={goToday} className="h-8 flex-1 px-3 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg sm:flex-none">
              Today
            </button>
            <button
              onClick={goNext}
              aria-label={view === 'week' ? 'Next week' : 'Next month'}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-gray-500 hover:bg-gray-100"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          {/* Date range */}
          <div className="text-sm font-semibold text-gray-900 sm:order-2">{rangeLabel}</div>
        </div>

        {busy && <ScheduleWeekSkeleton />}

        {!busy && activities.length === 0 && (
          <div className="rounded-xl border border-gray-200 bg-white p-8 text-center">
            <p className="text-sm text-gray-500 mb-3">You don't have any activities yet, so there's nothing to schedule.</p>
            <button onClick={() => navigate('/activities')} className="text-sm font-medium text-[#FA4D8D] hover:underline">
              Create an activity
            </button>
          </div>
        )}

        {!busy && activities.length > 0 && view === 'week' && (
          <div className="overflow-x-auto">
          {/* Mobile: a horizontal scroll strip showing ~2 day cards at a time,
              so each card is wide enough to read its sessions and you swipe
              through the week sideways. sm+: the full 7-column row (the
              min-w only forces a horizontal scroll when the portal itself is
              narrower than 900px). */}
          <div className="flex snap-x snap-mandatory gap-3 sm:grid sm:min-w-[900px] sm:snap-none sm:grid-cols-7">
            {weekDays.map((d) => {
              const daySessions = sessionsFor(d);
              // No cap here on purpose — a vendor asked to see the whole
              // day, not a truncated "+N more". Every card in the row still
              // lines up: with no explicit height on any of them, CSS
              // Grid's default stretch sizes the row to the tallest card's
              // real content and fills the rest with blank space, rather
              // than the min-height floor that caused the original "uneven"
              // complaint (a min-height changes what the browser treats as
              // that item's own minimum content size, which is what broke
              // stretch the first time this was tried).
              return (
                <div key={d.toISOString()} className="flex w-[calc(50%-0.375rem)] shrink-0 snap-start flex-col rounded-xl border border-gray-200 bg-white p-3 sm:w-auto sm:shrink">
                  <div className="mb-2 flex items-baseline justify-between">
                    <span className="text-xs font-medium text-gray-500">{format(d, 'EEE')}</span>
                    <button
                      type="button"
                      onClick={(e) => openDay(d, e.currentTarget)}
                      aria-label={`View bookings for ${format(d, 'EEEE d MMMM')}`}
                      className={cn(
                        'text-sm font-semibold transition-transform hover:scale-110',
                        isToday(d)
                          ? 'grid h-6 w-6 place-items-center rounded-full bg-[#FA4D8D] text-white'
                          : 'text-gray-900 hover:text-[#FA4D8D]'
                      )}
                    >
                      {format(d, 'd')}
                    </button>
                  </div>
                  <div className="flex-1 space-y-1.5">
                    {groupByStart(daySessions).map((g) =>
                      g.items.length === 1 ? (
                        <SlotCard
                          key={g.items[0].id}
                          s={g.items[0]}
                          onClick={() => navigate(`/bookings?session=${g.items[0].id}`)}
                        />
                      ) : (
                        <ParallelSlotGroup
                          key={g.key}
                          items={g.items}
                          onOpenSession={(id) => navigate(`/bookings?session=${id}`)}
                        />
                      )
                    )}
                    {daySessions.length === 0 && (
                      <div className="flex h-full min-h-[100px] flex-col items-center justify-center gap-1.5 text-gray-300">
                        <CalendarX2 className="h-5 w-5" />
                        <span className="text-xs">No sessions</span>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          </div>
        )}

        {!busy && activities.length > 0 && view === 'month' && (
          <div className="overflow-x-auto">
            <div className="grid min-w-[760px] grid-cols-7 gap-px overflow-hidden rounded-t-xl border border-b-0 border-gray-200 bg-gray-200">
              {/* The grid below is Monday-first (monthDays, from
                  startOfWeek(..., WEEK_OPTS)) — this header used to reuse
                  `weekDays`, the WEEK view's own *rolling 7-day-from-cursor*
                  window, which only happens to line up with the grid when
                  `cursor` itself is a Monday. Any other cursor shifted every
                  column's label by however many days off Monday it was (e.g.
                  cursor on a Tuesday labelled the Monday column "Tue"), so a
                  date's weekday looked wrong even though the underlying
                  schedule data was correct. Deriving the header from the same
                  `monthDays` array the cells use guarantees they can't drift
                  apart. */}
              {monthDays.slice(0, 7).map((d) => (
                <div key={d.toISOString()} className="bg-gray-50 px-3 py-2 text-xs font-medium text-gray-500">
                  {format(d, 'EEE')}
                </div>
              ))}
            </div>
            <div className="grid min-w-[760px] grid-cols-7 gap-px overflow-hidden rounded-b-xl border border-gray-200 bg-gray-200">
              {monthDays.map((d) => {
                const daySessions = sessionsFor(d);
                const visible = daySessions.slice(0, 3);
                const overflow = daySessions.length - visible.length;
                return (
                  <button
                    key={d.toISOString()}
                    onClick={(e) => openDay(d, e.currentTarget.querySelector('[data-daynum]'))}
                    className={cn(
                      'min-h-[110px] bg-white p-2 text-left align-top hover:bg-gray-50 transition-colors',
                      !isSameMonth(d, cursor) && 'bg-gray-50/60'
                    )}
                  >
                    <span
                      data-daynum
                      className={cn(
                        'inline-grid h-6 w-6 place-items-center rounded-full text-xs font-semibold',
                        isToday(d) ? 'bg-[#FA4D8D] text-white' : !isSameMonth(d, cursor) ? 'text-gray-300' : 'text-gray-900'
                      )}
                    >
                      {format(d, 'd')}
                    </span>
                    <div className="mt-1.5 space-y-1">
                      {groupByStart(visible).map((g) =>
                        g.items.length === 1 ? (
                          <div
                            key={g.items[0].id}
                            className={cn(
                              'truncate rounded px-1.5 py-0.5 text-[11px] font-medium',
                              g.items[0].bookingsPaused
                                ? 'bg-amber-100 text-amber-800'
                                : g.items[0].fromWix ? 'bg-purple-50 text-purple-700' : 'bg-pink-50 text-[#FA4D8D]'
                            )}
                            title={g.items[0].bookingsPaused ? 'Bookings paused for this session' : undefined}
                          >
                            {sgTime(g.items[0].starts_at)} {g.items[0].title}
                          </div>
                        ) : (
                          <div key={g.key} className="space-y-0.5">
                            <div className="px-0.5 text-[11px] font-semibold text-gray-700">{sgTime(g.items[0].starts_at)}</div>
                            <div className="flex flex-wrap gap-1">
                              {g.items.map((x) => (
                                <span
                                  key={x.id}
                                  title={x.title}
                                  className={cn(
                                    'inline-flex min-w-0 max-w-full items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium',
                                    x.bookingsPaused
                                      ? 'bg-amber-100 text-amber-800'
                                      : x.fromWix ? 'bg-purple-50 text-purple-700' : 'bg-pink-50 text-[#FA4D8D]'
                                  )}
                                >
                                  <i
                                    aria-hidden
                                    className={cn(
                                      'h-1.5 w-1.5 shrink-0 rounded-full',
                                      x.bookingsPaused ? 'bg-amber-500' : x.fromWix ? 'bg-purple-500' : 'bg-pink-500'
                                    )}
                                  />
                                  <span className="truncate">{x.title}</span>
                                </span>
                              ))}
                            </div>
                          </div>
                        )
                      )}
                      {overflow > 0 && <div className="px-1.5 text-[11px] text-gray-400">+{overflow} more</div>}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <DayDetailDialog
        date={dayDetail}
        origin={dayOrigin}
        sessions={dayDetail ? sessionsFor(dayDetail) : []}
        onClose={() => setDayDetail(null)}
        onOpenSession={(id) => { setDayDetail(null); navigate(`/bookings?session=${id}`); }}
      />
    </div>
  );
}

/** One week-view slot card: a coloured accent bar (consistent per activity —
 *  see accentFor), time, title with a chevron hinting it opens the booking
 *  roster, who's teaching it (when set), and capacity. Location and the
 *  Wix/Course badges still live in the day dialog, one tap away — the
 *  instructor is worth showing here too since "who's running this one"
 *  is exactly the kind of thing a vendor scans a whole week for. */
function SlotCard({
  s, onClick, hideTime = false,
}: { s: EnrichedSession; onClick: () => void; hideTime?: boolean }) {
  const full = s.capacity != null && s.booked >= s.capacity;
  const wixOverflow = s.wixClassOverflow;
  const accent = accentFor(s);
  // A course is enrolled as one whole programme, so this is the course's
  // total enrolment carried across every occurrence — not people booked for
  // this specific date — but it's still a real count, not just the bare
  // word "Enrolled" with no number (that was this card's own bug: dropping
  // the figure the original SessionCard always showed alongside the label).
  const count = s.isCourse
    ? `${s.booked}${s.capacity != null ? `/${s.capacity}` : ''} enrolled`
    : wixOverflow > 0
      ? `${s.capacity}/${s.capacity} +${wixOverflow}`
      : `${s.booked}${s.capacity != null ? `/${s.capacity}` : ''}`;
  // Instructor only — studio doesn't belong on this card. Some sessions
  // genuinely have no teacher on file (never entered, or a Wix-synced class
  // Wix itself has no such field for), shown as its own line rather than
  // silently omitted, so every card has the same shape and it's obvious at
  // a glance which sessions are missing one to fill in.
  const staff = s.teacherName?.trim() || 'No instructor set';
  return (
    <button
      type="button"
      onClick={onClick}
      title={wixOverflow > 0 ? `${s.capacity} on Wix · ${wixOverflow} held on BabyBrain beyond Wix capacity` : s.bookingsPaused ? 'Bookings paused for this session' : undefined}
      className="flex w-full items-stretch gap-2 rounded-lg border border-gray-100 bg-gray-50/60 py-1.5 pr-2.5 text-left transition-colors hover:bg-gray-100/80"
    >
      <span className={cn('w-1 shrink-0 rounded-full', accent.bar)} />
      <span className="min-w-0 flex-1">
        {!hideTime && <span className="block text-xs font-semibold text-gray-900">{sgTime(s.starts_at)}</span>}
        <span className="flex items-center justify-between gap-1">
          <span className="min-w-0 truncate text-xs text-gray-800">{s.title}</span>
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-gray-400" />
        </span>
        <span className={cn('flex items-center gap-1 truncate text-[11px]', s.teacherName?.trim() ? 'text-purple-700' : 'text-gray-400')}>
          <UserIcon className="h-3 w-3 shrink-0" />
          <span className="truncate">{staff}</span>
        </span>
        <span className={cn('flex items-center gap-1 text-[11px]', full ? 'font-medium text-[#FA4D8D]' : 'text-gray-500')}>
          <Users className="h-3 w-3 shrink-0" />
          {count}
        </span>
      </span>
    </button>
  );
}

/** Same-time parallel classes collapse to one chip — "9:00am · 3 classes" —
 *  so a busy slot costs about the same space as a single session; expanding
 *  it reveals each class as its own coloured-dot row, same accent as its
 *  SlotCard would use elsewhere in the week. */
function ParallelSlotGroup({
  items, onOpenSession,
}: { items: EnrichedSession[]; onOpenSession: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const first = items[0];
  const sameEnd = items.every((x) => x.ends_at === first.ends_at);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-stretch gap-2 rounded-lg border border-purple-100 bg-purple-50/60 py-1.5 pr-2.5 text-left transition-colors hover:bg-purple-50"
      >
        <span className="w-1 shrink-0 rounded-full bg-purple-400" />
        <span className="flex min-w-0 flex-1 items-center justify-between gap-1">
          <span className="min-w-0">
            <span className="block text-xs font-semibold text-gray-900">{sgTime(first.starts_at)}{sameEnd ? ` – ${sgTime(first.ends_at)}` : ''}</span>
            <span className="flex items-center gap-1 text-[11px] text-purple-700">
              <Users className="h-3 w-3 shrink-0" />
              {items.length} sessions
            </span>
          </span>
          <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-purple-400 transition-transform', open && 'rotate-180')} />
        </span>
      </button>
      {open && (
        <div className="mt-1.5 space-y-1.5 pl-2">
          {items.map((x) => (
            <SlotCard key={x.id} s={x} hideTime onClick={() => onOpenSession(x.id)} />
          ))}
        </div>
      )}
    </div>
  );
}
