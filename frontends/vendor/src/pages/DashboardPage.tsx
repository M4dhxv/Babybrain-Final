import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { getChatClient } from '@/lib/chat';
import { useAuth } from '@/auth/AuthProvider';
import { useProviderQuery } from '@/lib/useProviderQuery';
import { DashboardSkeleton, RefreshBar } from '@/components/Skeletons';
import type { ProviderOverview } from '@/lib/database.types';
import {
  CalendarPlus,
  Package,
  MapPin,
  CalendarDays,
  Users,

  UserPlus,
  DollarSign,
  ArrowRight,
  TrendingUp,
  Sun,
  MessageSquare,
  SlidersHorizontal,
  ChevronDown,
  CalendarCheck,
  Baby,
} from 'lucide-react';
import { cn } from '@/lib/utils';

/* Every card used to send you to /bookings regardless of what you clicked, so
   "View details" on Attendance, Waitlist and Revenue all landed in the same
   place. `to` is where each one actually belongs.
   "Ongoing Sessions" replaced with unread messages — QA: it "isn't that useful
   an analytic", and a count of replies owed is something a vendor acts on. */
const statsCards = [
  { icon: CalendarDays, label: 'Bookings', value: '28', sub: 'this week', change: '22%', color: 'text-pink-600', bg: 'bg-pink-100', to: '/bookings' },
  { icon: Users, label: 'Attendance rate', value: '92%', sub: 'this week', change: '8%', color: 'text-purple-600', bg: 'bg-purple-100', to: '/bookings?tab=Attendance' },
  { icon: MessageSquare, label: 'Messages to reply', value: '0', sub: 'awaiting a response', change: null, color: 'text-yellow-600', bg: 'bg-yellow-100', to: '/messages' },
  { icon: UserPlus, label: 'Waitlist', value: '14', sub: 'children', change: null, color: 'text-blue-600', bg: 'bg-blue-100', to: '/bookings?tab=Waitlist' },
  { icon: DollarSign, label: 'Revenue', value: '$3,240', sub: 'this month', change: '18%', color: 'text-green-600', bg: 'bg-green-100', to: '/billing' },
];

const sessionIcons = [Baby, CalendarCheck, Sun];
const sessionColors = ['bg-pink-300 text-pink-800', 'bg-purple-300 text-purple-800', 'bg-yellow-300 text-yellow-800', 'bg-blue-300 text-blue-800'];
const sgWhen = (iso: string) =>
  new Date(iso).toLocaleString('en-SG', { timeZone: 'Asia/Singapore', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

type UpcomingSession = {
  id: string; when: string; name: string; booked: number; capacity: number | null; location: string | null;
  // Wix-linked weekly CLASS only: confirmed seats held past the (immutable,
  // Wix-mirrored) capacity — promoted + paid from the waitlist (00108).
  // Rendered as "n/n +x" instead of an oversold "n+x/n". 0 otherwise.
  overflow: number;
};
type RecentBooking = {
  id: string; child: string; activity: string; time: string; status: string;
  isRepeat: boolean; packageName: string | null;
};


/** "Good morning/afternoon/evening" in Singapore time. */
function sgGreeting() {
  const hour = Number(new Intl.DateTimeFormat('en-SG', { timeZone: 'Asia/Singapore', hour: 'numeric', hour12: false }).format(new Date()));
  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}

type DashboardData = {
  overview: ProviderOverview | null;
  upcoming: UpcomingSession[];
  recent: RecentBooking[];
  attendanceRate: string | null;
};
const EMPTY_UPCOMING: UpcomingSession[] = [];
const EMPTY_RECENT: RecentBooking[] = [];

export default function DashboardPage() {
  const navigate = useNavigate();
  const { provider } = useAuth();
  /* Both header buttons used to navigate('/bookings') regardless of what was
     clicked. They're real controls now: the date range narrows Upcoming
     Sessions to a window (sessions are fetched 90 days out so every preset has
     data to show), and Filters narrows Recent Bookings by status — both
     client-side, since neither list needs a new backend endpoint to do this
     honestly. */
  const RANGE_PRESETS = [
    { key: '7d', label: 'Next 7 days', days: 7 },
    { key: '30d', label: 'Next 30 days', days: 30 },
    { key: '90d', label: 'Next 90 days', days: 90 },
  ] as const;
  const [rangeKey, setRangeKey] = useState<(typeof RANGE_PRESETS)[number]['key']>('7d');
  const [rangeOpen, setRangeOpen] = useState(false);
  const STATUS_FILTERS = ['All', 'Confirmed', 'Waitlisted', 'Cancelled', 'Completed'] as const;
  const [statusFilter, setStatusFilter] = useState<(typeof STATUS_FILTERS)[number]>('All');
  const [filterOpen, setFilterOpen] = useState(false);
  /* Replies owed, straight from Stream's own unread counter — something the
     vendor can act on, unlike the session count this card used to show. */
  const [unreadCount, setUnreadCount] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    getChatClient()
      .then((c) => c.getUnreadCount())
      .then((u) => { if (!cancelled) setUnreadCount(u.total_unread_count ?? 0); })
      .catch(() => { if (!cancelled) setUnreadCount(0); });
    return () => { cancelled = true; };
  }, []);

  // Everything the dashboard shows, in one stale-while-revalidate read: a
  // revisit paints the last figures instantly and refreshes them behind a thin
  // top bar, instead of blanking to a loader. Every query below is byte-for-byte
  // the one this page has always run — only the plumbing changed.
  const { data, loading, refreshing } = useProviderQuery<DashboardData>(
    provider ? `dashboard:${provider.id}` : null,
    async () => {
      const { data: ov } = await supabase.rpc('provider_overview', { p_provider: provider!.id });
      const overview = (ov?.[0] as ProviderOverview) ?? null;

      const [{ data: acts }, { data: locs }] = await Promise.all([
        supabase.from('activities').select('id, title, location_id, wix_service_type').eq('provider_id', provider!.id),
        supabase.from('provider_locations').select('id, name').eq('provider_id', provider!.id),
      ]);
      const titleOf = new Map((acts ?? []).map((a) => [a.id, a.title]));
      const activityLocationOf = new Map((acts ?? []).map((a) => [a.id, a.location_id]));
      const wixTypeOf = new Map((acts ?? []).map((a) => [a.id, a.wix_service_type]));
      const locationNameOf = new Map((locs ?? []).map((l) => [l.id, l.name]));
      const ids = [...titleOf.keys()];
      if (!ids.length) return { overview, upcoming: [], recent: [], attendanceRate: null };

      const nowIso = new Date().toISOString();
      // Fetched 90 days out (not just the next 4) so the date-range control has
      // something to actually narrow — it used to just navigate to /bookings.
      const in90dIso = new Date(Date.now() + 90 * 864e5).toISOString();
      const { data: sess } = await supabase
        .from('activity_sessions')
        .select('id, activity_id, starts_at, capacity, location_id, wix_remaining_capacity')
        .in('activity_id', ids)
        .gte('starts_at', nowIso)
        .lte('starts_at', in90dIso)
        .order('starts_at')
        .limit(60);
      const sessIds = (sess ?? []).map((s) => s.id);
      const counts: Record<string, number> = {};
      if (sessIds.length) {
        const { data: bks } = await supabase
          .from('bookings')
          .select('session_id, status')
          .in('session_id', sessIds);
        (bks ?? []).forEach((b) => {
          if (b.status === 'confirmed' || b.status === 'completed') counts[b.session_id] = (counts[b.session_id] ?? 0) + 1;
        });
      }
      const upcoming: UpcomingSession[] = (sess ?? []).map((s) => {
        const locId = s.location_id ?? activityLocationOf.get(s.activity_id) ?? null;
        const booked = counts[s.id] ?? 0;
        // A Wix class's capacity mirrors Wix and can't be raised from here
        // (00108) — held seats past it are BabyBrain's promoted-paid overflow.
        // Uses the higher of Wix's own filled figure and our confirmed rows;
        // the waitlist never feeds `counts` above.
        const wixFilled =
          s.wix_remaining_capacity != null && s.capacity != null
            ? Math.max(0, s.capacity - s.wix_remaining_capacity)
            : 0;
        const overflow =
          wixTypeOf.get(s.activity_id) === 'CLASS' && s.capacity != null
            ? Math.max(0, Math.max(booked, wixFilled) - s.capacity)
            : 0;
        return {
          id: s.id, when: s.starts_at, name: titleOf.get(s.activity_id) ?? 'Activity',
          booked, capacity: s.capacity,
          location: locId ? locationNameOf.get(locId) ?? null : null,
          overflow,
        };
      });

      // 1.3: recent bookings with the booked child's name (security-definer RPC).
      // Fetched 30 (not 4) so the status filter has more than one screenful to
      // narrow.
      const { data: recentRows } = await supabase
        .rpc('provider_recent_bookings', { p_provider: provider!.id, p_limit: 30 });
      const recent: RecentBooking[] = (recentRows ?? []).map((r) => ({
        id: r.booking_id,
        child: r.child_name,
        activity: r.activity_title,
        time: sgWhen(r.starts_at),
        status: r.status,
        isRepeat: r.is_repeat,
        packageName: r.package_name,
      }));

      // Attendance rate = present / marked, across this provider's non-cancelled
      // bookings.
      const { data: allBks } = await supabase
        .from('bookings')
        .select('id, status, created_at, session_id')
        .eq('provider_id', provider!.id)
        .neq('status', 'cancelled')
        .order('created_at', { ascending: false });
      const bks = allBks ?? [];
      let attendanceRate: string | null = null;
      if (bks.length) {
        const { data: att } = await supabase
          .from('attendance')
          .select('status')
          .in('booking_id', bks.map((b) => b.id));
        const marked = (att ?? []).filter((a) => a.status === 'present' || a.status === 'absent');
        attendanceRate = marked.length
          ? `${Math.round((marked.filter((a) => a.status === 'present').length / marked.length) * 100)}%`
          : null;
      }

      return { overview, upcoming, recent, attendanceRate };
    },
  );
  const overview = data?.overview ?? null;
  const upcoming = data?.upcoming ?? EMPTY_UPCOMING;
  const recent = data?.recent ?? EMPTY_RECENT;
  const attendanceRate = data?.attendanceRate ?? null;
  const loaded = !loading;

  // Live values mapped onto the existing card config (icons/labels/colours
  // stay; only the numbers come from the backend). Order matches statsCards:
  // Bookings · Attendance Rate · Messages to reply · Waitlist · Revenue.
  const liveValues: (string | null)[] = overview
    ? [
        String(overview.upcoming_bookings),
        attendanceRate ?? '—',
        unreadCount != null ? String(unreadCount) : '—',
        String(overview.pending_waitlist),
        `$${Number(overview.revenue).toLocaleString()}`,
      ]
    : [null, null, null, null, null];
  const firstName = provider?.business_name?.split(' ')[0] ?? 'there';

  const activeRangeDays = RANGE_PRESETS.find((r) => r.key === rangeKey)!.days;
  const rangeCutoff = Date.now() + activeRangeDays * 864e5;
  const visibleUpcoming = upcoming.filter((s) => new Date(s.when).getTime() <= rangeCutoff);
  /* QA 21/08: "should display a maximum of 10 listings on overview". The RPC
     still fetches 30 so the status filter has something to filter — the cap is
     on what the overview shows, applied after filtering so picking a status
     doesn't leave a near-empty list. */
  const RECENT_ON_OVERVIEW = 10;
  const visibleRecent = (statusFilter === 'All' ? recent : recent.filter((r) => r.status.toLowerCase() === statusFilter.toLowerCase()))
    .slice(0, RECENT_ON_OVERVIEW);

  return (
    <div className="relative">
      {refreshing && <RefreshBar />}
      {/* Top Bar */}
      <div className="flex flex-col items-center gap-4 px-4 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-8">
        <div className="w-full text-center sm:w-auto sm:text-left">
          <h1 className="text-2xl font-bold text-gray-900">{sgGreeting()}, {firstName}. <span className="text-2xl">👋</span></h1>
          <p className="text-sm text-gray-500 mt-1">Here's what's happening with your business today.</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="relative">
            <button
              onClick={() => { setRangeOpen((v) => !v); setFilterOpen(false); }}
              className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 rounded-xl text-sm text-gray-700 hover:bg-gray-50"
            >
              <CalendarDays className="w-4 h-4" />
              {RANGE_PRESETS.find((r) => r.key === rangeKey)!.label}
              <ChevronDown className="w-4 h-4" />
            </button>
            {rangeOpen && (
              <div className="absolute right-0 top-full mt-1 w-44 bg-white border border-gray-200 rounded-xl shadow-lg z-20 py-1">
                {RANGE_PRESETS.map((r) => (
                  <button
                    key={r.key}
                    onClick={() => { setRangeKey(r.key); setRangeOpen(false); }}
                    className={cn('block w-full text-left px-4 py-2 text-sm hover:bg-gray-50', r.key === rangeKey ? 'text-[#FA4D8D] font-medium' : 'text-gray-700')}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="relative">
            <button
              onClick={() => { setFilterOpen((v) => !v); setRangeOpen(false); }}
              className={cn('flex items-center gap-2 px-4 py-2 bg-white border rounded-xl text-sm hover:bg-gray-50', statusFilter !== 'All' ? 'border-[#C90044] text-[#FA4D8D]' : 'border-gray-200 text-gray-700')}
            >
              <SlidersHorizontal className="w-4 h-4" />
              {statusFilter === 'All' ? 'Filters' : statusFilter}
            </button>
            {filterOpen && (
              <div className="absolute right-0 top-full mt-1 w-44 bg-white border border-gray-200 rounded-xl shadow-lg z-20 py-1">
                {STATUS_FILTERS.map((f) => (
                  <button
                    key={f}
                    onClick={() => { setStatusFilter(f); setFilterOpen(false); }}
                    className={cn('block w-full text-left px-4 py-2 text-sm hover:bg-gray-50', f === statusFilter ? 'text-[#FA4D8D] font-medium' : 'text-gray-700')}
                  >
                    {f}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="px-4 pb-8 sm:px-8">
        {/* Quick Actions */}
        <div className="grid grid-cols-1 gap-4 mb-6 sm:grid-cols-2 lg:grid-cols-3">
          <button onClick={() => navigate('/activities?new=activity')} className="flex items-center gap-4 p-4 bg-white rounded-xl border border-gray-200 hover:shadow-card-hover transition-shadow text-left">
            <div className="w-12 h-12 bg-pink-100 rounded-xl flex items-center justify-center">
              <CalendarPlus className="w-6 h-6 text-[#FA4D8D]" />
            </div>
            <div className="flex-1">
              <div className="font-semibold text-gray-900">Add an activity</div>
              <div className="text-xs text-gray-500">Create a new class<br/>or activity</div>
            </div>
            <ArrowRight className="w-5 h-5 text-gray-400" />
          </button>
          <button onClick={() => navigate('/packages?new=pack')} className="flex items-center gap-4 p-4 bg-white rounded-xl border border-gray-200 hover:shadow-card-hover transition-shadow text-left">
            <div className="w-12 h-12 bg-purple-100 rounded-xl flex items-center justify-center">
              <Package className="w-6 h-6 text-purple-600" />
            </div>
            <div className="flex-1">
              <div className="font-semibold text-gray-900">Create a package</div>
              <div className="text-xs text-gray-500">Bundle your activities<br/>together</div>
            </div>
            <ArrowRight className="w-5 h-5 text-gray-400" />
          </button>
          <button onClick={() => navigate('/activities?tab=locations&new=location')} className="flex items-center gap-4 p-4 bg-white rounded-xl border border-gray-200 hover:shadow-card-hover transition-shadow text-left">
            <div className="w-12 h-12 bg-blue-100 rounded-xl flex items-center justify-center">
              <MapPin className="w-6 h-6 text-blue-600" />
            </div>
            <div className="flex-1">
              <div className="font-semibold text-gray-900">Add a location</div>
              <div className="text-xs text-gray-500">Add a new venue<br/>or location</div>
            </div>
            <ArrowRight className="w-5 h-5 text-gray-400" />
          </button>
        </div>

        {/* Cold load: hold the shape of the stats + lists rather than showing
            the placeholder demo numbers this config carries. A revisit skips
            this entirely — the cached figures are already on screen. */}
        {loading && <DashboardSkeleton />}

        {!loading && <>
        {/* Stats Cards */}
        <div className="grid grid-cols-2 gap-4 mb-6 sm:grid-cols-3 lg:grid-cols-5">
          {statsCards.map((stat, i) => (
            <div key={stat.label} className="bg-white rounded-xl border border-gray-200 p-4">
              <div className="flex items-center gap-2 mb-3">
                <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center', stat.bg)}>
                  <stat.icon className={cn('w-4 h-4', stat.color)} />
                </div>
                <span className="text-xs font-medium text-gray-600">{stat.label}</span>
              </div>
              <div className="text-2xl font-bold text-gray-900 mb-1">{liveValues[i] ?? '—'}</div>
              <div className="text-xs text-gray-500 mb-2">{stat.sub}</div>
              {stat.change && (
                <div className="flex items-center gap-1 text-xs text-green-600 mb-3">
                  <TrendingUp className="w-3 h-3" />
                  {stat.change} vs last week
                </div>
              )}
              {!stat.change && <div className="mb-3" />}
              <button onClick={() => navigate(stat.to)} className="flex items-center gap-1 text-xs font-medium text-[#FA4D8D] hover:underline">
                View details
                <ArrowRight className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>

        {/* Bottom Grid */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {/* Upcoming Sessions */}
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-gray-900">Upcoming sessions</h3>
              <button onClick={() => navigate('/schedule')} className="text-xs text-[#FA4D8D] font-medium">View all</button>
            </div>
            <div className="space-y-4">
              {visibleUpcoming.map((session, idx) => {
                const Icon = sessionIcons[idx % sessionIcons.length];
                return (
                  <div key={session.id} className="flex items-center gap-3">
                    <div className={cn('w-10 h-10 rounded-lg flex items-center justify-center', sessionColors[idx % sessionColors.length])}>
                      <Icon className="w-5 h-5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-gray-500">{sgWhen(session.when)}</div>
                      <div className="text-sm font-medium text-gray-900 truncate">{session.name}</div>
                      {session.location && (
                        <div className="flex items-center gap-1 text-xs text-gray-400 truncate">
                          <MapPin className="h-3 w-3 flex-shrink-0" /> {session.location}
                        </div>
                      )}
                    </div>
                    <div className="text-right">
                      {session.overflow > 0 ? (
                        <>
                          <div
                            className="text-sm font-semibold text-gray-900"
                            title={`${session.capacity} on Wix · ${session.overflow} held on BabyBrain beyond Wix capacity`}
                          >
                            {session.capacity} / {session.capacity} <span className="text-[#FA4D8D]">+{session.overflow}</span>
                          </div>
                          <div className="text-xs text-gray-500">Booked · held on BabyBrain</div>
                        </>
                      ) : (
                        <>
                          <div className="text-sm font-semibold text-gray-900">{session.booked}{session.capacity != null ? ` / ${session.capacity}` : ''}</div>
                          <div className="text-xs text-gray-500">Booked</div>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
              {loaded && visibleUpcoming.length === 0 && <div className="text-sm text-gray-400">No sessions in this range.</div>}
            </div>
            <button onClick={() => navigate('/schedule')} className="flex items-center gap-1 mt-4 text-xs font-medium text-[#FA4D8D]">
              View full schedule
              <ArrowRight className="w-3 h-3" />
            </button>
          </div>

          {/* Recent Bookings */}
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-gray-900">Recent bookings</h3>
              <button onClick={() => navigate('/bookings')} className="text-xs text-[#FA4D8D] font-medium">View all</button>
            </div>
            <div className="space-y-4">
              {visibleRecent.map((booking, idx) => (
                <div key={booking.id} className="flex items-center gap-3">
                  <div className={cn('w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold', sessionColors[idx % sessionColors.length])}>
                    {booking.child.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-900 truncate">{booking.child}</div>
                    <div className="text-xs text-gray-500 truncate">{booking.activity}{booking.time ? ` · ${booking.time}` : ''}</div>
                    {/* QA: "'confirmed' doesn't add much value... is it possible
                        to tag whether a booking is 'New' or 'Repeat' or what
                        type of package it was booked with". New/Repeat is
                        derived from this parent's booking history with this
                        provider. Pack type only shows for bookings made with a
                        package credit going forward — bookings never recorded
                        which pack paid for them until this migration, so a
                        historic booking or a direct one-off both read "Single
                        class" rather than a guess. */}
                    <div className="mt-0.5 flex items-center gap-1.5">
                      <span className={cn(
                        'inline-block px-1.5 py-0.5 text-[10px] font-medium rounded',
                        booking.isRepeat ? 'bg-purple-50 text-purple-600' : 'bg-emerald-50 text-emerald-600'
                      )}>
                        {booking.isRepeat ? 'Repeat' : 'New'}
                      </span>
                      <span className="text-[10px] text-gray-400">{booking.packageName ?? 'Single class'}</span>
                    </div>
                  </div>
                  <div className="text-right">
                    <span className={cn(
                      'inline-block px-2 py-0.5 text-xs rounded-full mt-1 capitalize',
                      booking.status === 'confirmed' || booking.status === 'completed' ? 'bg-green-300 text-green-800'
                        : booking.status === 'waitlisted' ? 'bg-blue-300 text-blue-800' : 'bg-yellow-300 text-yellow-800'
                    )}>
                      {booking.status}
                    </span>
                  </div>
                </div>
              ))}
              {loaded && visibleRecent.length === 0 && <div className="text-sm text-gray-400">No {statusFilter === 'All' ? '' : statusFilter.toLowerCase() + ' '}bookings yet.</div>}
            </div>
            <button onClick={() => navigate('/bookings')} className="flex items-center gap-1 mt-4 text-xs font-medium text-[#FA4D8D]">
              View all bookings
              <ArrowRight className="w-3 h-3" />
            </button>
          </div>

          {/* Insights moved to its own tab — it is the headline Pro feature, and
              the copy here showed the same hardcoded age group, days and
              locations to every vendor. */}
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <h3 className="font-semibold text-gray-900 mb-2">Insights</h3>
            <p className="text-sm text-gray-500">
              Which activities convert, which age groups book, and the days and times parents choose.
            </p>
            <button onClick={() => navigate('/insights')} className="mt-4 flex items-center gap-1 text-xs font-medium text-[#FA4D8D]">
              Open insights
              <ArrowRight className="w-3 h-3" />
            </button>
          </div>
        </div>
        </>}
      </div>

      {/* Floating Chat Button.
          This used to open a drawer with its own hardcoded conversation list —
          a second, fake "Messages" completely disconnected from the real
          Stream-backed inbox at /messages (different names, no real unread
          state, a search box with no onChange, and a pen icon with no
          onClick). QA: "shouldn't they be the same? Currently they are
          showing different messages" — they were never the same data. Rather
          than maintain two message UIs in parallel, this now opens the one
          real inbox, with its own real unread count. */}
      <button
        onClick={() => navigate('/messages')}
        className="fixed bottom-6 right-6 w-14 h-14 gradient-primary rounded-full flex items-center justify-center hover:opacity-90 transition-opacity z-50"
        title="Open messages"
      >
        <MessageSquare className="w-6 h-6 text-white" />
        {!!unreadCount && (
          <span className="absolute -top-1 -right-1 min-w-5 h-5 px-1 bg-[#FA4D8D] text-white text-xs rounded-full flex items-center justify-center border-2 border-white">
            {unreadCount}
          </span>
        )}
      </button>
        </div>
  );
}
