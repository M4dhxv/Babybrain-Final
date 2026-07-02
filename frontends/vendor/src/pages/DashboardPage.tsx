import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/auth/AuthProvider';
import type { ProviderOverview } from '@/lib/database.types';
import {
  CalendarPlus,
  Package,
  MapPin,
  CalendarDays,
  Users,
  Clock,
  UserPlus,
  DollarSign,
  ArrowRight,
  TrendingUp,
  Sun,
  MessageSquare,
  Search,
  SlidersHorizontal,
  ChevronDown,
  X,
  Edit3,
  CalendarCheck,
  Baby,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const statsCards = [
  { icon: CalendarDays, label: 'Bookings', value: '28', sub: 'this week', change: '22%', color: 'text-pink-600', bg: 'bg-pink-100' },
  { icon: Users, label: 'Attendance Rate', value: '92%', sub: 'this week', change: '8%', color: 'text-purple-600', bg: 'bg-purple-100' },
  { icon: Clock, label: 'Ongoing Sessions', value: '12', sub: 'in next 7 days', change: null, color: 'text-yellow-600', bg: 'bg-yellow-100' },
  { icon: UserPlus, label: 'Waitlist', value: '14', sub: 'children', change: null, color: 'text-blue-600', bg: 'bg-blue-100' },
  { icon: DollarSign, label: 'Revenue', value: '$3,240', sub: 'this month', change: '18%', color: 'text-green-600', bg: 'bg-green-100' },
];

const upcomingSessions = [
  { time: 'Today, 9:00 AM', name: 'Little Movers (18m – 3y)', booked: '12 / 15', icon: Baby, color: 'bg-pink-100 text-pink-600' },
  { time: 'Today, 10:30 AM', name: 'Music & Movement (2 – 5y)', booked: '10 / 12', icon: CalendarCheck, color: 'bg-purple-100 text-purple-600' },
  { time: 'Today, 12:00 PM', name: 'Play Explorers (3 – 5y)', booked: '8 / 10', icon: Sun, color: 'bg-yellow-100 text-yellow-600' },
];

const recentBookings = [
  { initials: 'SJ', name: 'Sarah J.', activity: 'Little Movers (18m – 3y)', time: 'Today, 9:00 AM', status: 'Confirmed', color: 'bg-pink-100 text-pink-600' },
  { initials: 'EJ', name: 'Emma J.', activity: 'Music & Movement (2 – 5y)', time: 'Today, 10:30 AM', status: 'Confirmed', color: 'bg-purple-100 text-purple-600' },
  { initials: 'MT', name: 'Marcus T.', activity: 'Play Explorers (3 – 5y)', time: 'Tomorrow, 9:00 AM', status: 'Confirmed', color: 'bg-yellow-100 text-yellow-600' },
  { initials: 'LT', name: 'Liam T.', activity: 'Little Movers (18m – 3y)', time: 'Tomorrow, 10:30 AM', status: 'Pending', color: 'bg-blue-100 text-blue-600' },
];

const messages = [
  { initials: 'SJ', name: 'S. J.', message: 'Hi! Is there a makeup class available this week?', time: '9:41 AM', count: 2, color: 'bg-pink-100 text-pink-600' },
  { initials: 'MT', name: 'M. T.', message: 'Thanks! See you tomorrow.', time: 'Yesterday', count: 1, color: 'bg-yellow-100 text-yellow-600' },
  { initials: 'EJ', name: 'E. J.', message: 'Can I bring my younger baby too?', time: 'Yesterday', count: 1, color: 'bg-purple-100 text-purple-600' },
  { initials: 'DK', name: 'D. K.', message: 'Great class! My son loves it.', time: 'Mon', count: 0, color: 'bg-blue-100 text-blue-600' },
];

const barChartData = [
  { day: 'Mon', height: 30 },
  { day: 'Tue', height: 35 },
  { day: 'Wed', height: 55 },
  { day: 'Thu', height: 50 },
  { day: 'Fri', height: 65 },
  { day: 'Sat', height: 100 },
  { day: 'Sun', height: 40 },
];

// Drill-down for the top age group: where demand concentrates for these
// classes, so vendors can see what's working and where to add capacity.
const topAgeInsight = {
  ageGroup: '1 – 2 yrs',
  topDays: ['Saturday', 'Sunday', 'Friday'],
  topTimes: ['9:30 AM', '10:30 AM', '4:00 PM'],
  topLocations: ['Suntec City', 'East Coast'],
};

export default function DashboardPage() {
  const [showMessages, setShowMessages] = useState(false);
  const [showAgeDetail, setShowAgeDetail] = useState(false);
  const { provider } = useAuth();
  const [overview, setOverview] = useState<ProviderOverview | null>(null);

  useEffect(() => {
    if (!provider) return;
    supabase
      .rpc('provider_overview', { p_provider: provider.id })
      .then(({ data }) => setOverview((data?.[0] as ProviderOverview) ?? null));
  }, [provider]);

  // Live values mapped onto the existing card config (icons/labels/colours
  // stay; only the numbers come from the backend). Order matches statsCards:
  // Bookings · Attendance Rate · Ongoing Sessions · Waitlist · Revenue.
  const liveValues: (string | null)[] = overview
    ? [
        String(overview.upcoming_bookings),
        '—', // attendance rate comes from provider_analytics (wired with that page)
        '—',
        String(overview.pending_waitlist),
        `$${Number(overview.revenue).toLocaleString()}`,
      ]
    : [null, null, null, null, null];
  const firstName = provider?.business_name?.split(' ')[0] ?? 'there';

  return (
    <div className="relative">
      {/* Top Bar */}
      <div className="flex items-center justify-between px-8 py-5">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Welcome back, {firstName}. <span className="text-2xl">👋</span></h1>
          <p className="text-sm text-gray-500 mt-1">Here's what's happening with your business today.</p>
        </div>
        <div className="flex items-center gap-3">
          <button className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 rounded-xl text-sm text-gray-700 hover:bg-gray-50">
            <CalendarDays className="w-4 h-4" />
            13 Jun – 19 Jun 2026
            <ChevronDown className="w-4 h-4" />
          </button>
          <button className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 rounded-xl text-sm text-gray-700 hover:bg-gray-50">
            <SlidersHorizontal className="w-4 h-4" />
            Filters
          </button>
        </div>
      </div>

      <div className="px-8 pb-8">
        {/* Quick Actions */}
        <div className="grid grid-cols-3 gap-4 mb-6">
          <button className="flex items-center gap-4 p-4 bg-white rounded-xl border border-gray-200 hover:shadow-card-hover transition-shadow text-left">
            <div className="w-12 h-12 bg-pink-100 rounded-xl flex items-center justify-center">
              <CalendarPlus className="w-6 h-6 text-[#E91E63]" />
            </div>
            <div className="flex-1">
              <div className="font-semibold text-gray-900">Add a Class</div>
              <div className="text-xs text-gray-500">Create a new class<br/>or activity</div>
            </div>
            <ArrowRight className="w-5 h-5 text-gray-400" />
          </button>
          <button className="flex items-center gap-4 p-4 bg-white rounded-xl border border-gray-200 hover:shadow-card-hover transition-shadow text-left">
            <div className="w-12 h-12 bg-purple-100 rounded-xl flex items-center justify-center">
              <Package className="w-6 h-6 text-purple-600" />
            </div>
            <div className="flex-1">
              <div className="font-semibold text-gray-900">Create a Package</div>
              <div className="text-xs text-gray-500">Bundle your classes<br/>together</div>
            </div>
            <ArrowRight className="w-5 h-5 text-gray-400" />
          </button>
          <button className="flex items-center gap-4 p-4 bg-white rounded-xl border border-gray-200 hover:shadow-card-hover transition-shadow text-left">
            <div className="w-12 h-12 bg-blue-100 rounded-xl flex items-center justify-center">
              <MapPin className="w-6 h-6 text-blue-600" />
            </div>
            <div className="flex-1">
              <div className="font-semibold text-gray-900">Add a Location</div>
              <div className="text-xs text-gray-500">Add a new venue<br/>or location</div>
            </div>
            <ArrowRight className="w-5 h-5 text-gray-400" />
          </button>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-5 gap-4 mb-6">
          {statsCards.map((stat, i) => (
            <div key={stat.label} className="bg-white rounded-xl border border-gray-200 p-4">
              <div className="flex items-center gap-2 mb-3">
                <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center', stat.bg)}>
                  <stat.icon className={cn('w-4 h-4', stat.color)} />
                </div>
                <span className="text-xs font-medium text-gray-600">{stat.label}</span>
              </div>
              <div className="text-2xl font-bold text-gray-900 mb-1">{liveValues[i] ?? stat.value}</div>
              <div className="text-xs text-gray-500 mb-2">{stat.sub}</div>
              {stat.change && (
                <div className="flex items-center gap-1 text-xs text-green-600 mb-3">
                  <TrendingUp className="w-3 h-3" />
                  {stat.change} vs last week
                </div>
              )}
              {!stat.change && <div className="mb-3" />}
              <button className="flex items-center gap-1 text-xs font-medium text-[#E91E63] hover:underline">
                View Details
                <ArrowRight className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>

        {/* Bottom Grid */}
        <div className="grid grid-cols-3 gap-6">
          {/* Upcoming Sessions */}
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-gray-900">Upcoming Sessions</h3>
              <button className="text-xs text-[#E91E63] font-medium">View all</button>
            </div>
            <div className="space-y-4">
              {upcomingSessions.map((session, idx) => (
                <div key={idx} className="flex items-center gap-3">
                  <div className={cn('w-10 h-10 rounded-lg flex items-center justify-center', session.color)}>
                    <session.icon className="w-5 h-5" />
                  </div>
                  <div className="flex-1">
                    <div className="text-xs text-gray-500">{session.time}</div>
                    <div className="text-sm font-medium text-gray-900">{session.name}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-semibold text-gray-900">{session.booked}</div>
                    <div className="text-xs text-gray-500">Booked</div>
                  </div>
                </div>
              ))}
            </div>
            <button className="flex items-center gap-1 mt-4 text-xs font-medium text-[#E91E63]">
              View full schedule
              <ArrowRight className="w-3 h-3" />
            </button>
          </div>

          {/* Recent Bookings */}
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-gray-900">Recent Bookings</h3>
              <button className="text-xs text-[#E91E63] font-medium">View all</button>
            </div>
            <div className="space-y-4">
              {recentBookings.map((booking, idx) => (
                <div key={idx} className="flex items-center gap-3">
                  <div className={cn('w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold', booking.color)}>
                    {booking.initials}
                  </div>
                  <div className="flex-1">
                    <div className="text-sm font-medium text-gray-900">{booking.name}</div>
                    <div className="text-xs text-gray-500">{booking.activity}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs text-gray-500">{booking.time}</div>
                    <span className={cn(
                      'inline-block px-2 py-0.5 text-xs rounded-full mt-1',
                      booking.status === 'Confirmed' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'
                    )}>
                      {booking.status}
                    </span>
                  </div>
                </div>
              ))}
            </div>
            <button className="flex items-center gap-1 mt-4 text-xs font-medium text-[#E91E63]">
              View all bookings
              <ArrowRight className="w-3 h-3" />
            </button>
          </div>

          {/* Insights */}
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <h3 className="font-semibold text-gray-900 mb-4">Insights</h3>
            <div className="mb-4">
              <button
                onClick={() => setShowAgeDetail((s) => !s)}
                className="w-full text-left group"
              >
                <div className="text-xs text-gray-500 mb-1 flex items-center gap-1">
                  Top age group
                  <ChevronDown className={cn('w-3 h-3 transition-transform', showAgeDetail && 'rotate-180')} />
                </div>
                <div className="text-xl font-bold text-purple-600 group-hover:underline">{topAgeInsight.ageGroup}</div>
                <div className="text-[11px] text-gray-400">Tap to see popular days, times &amp; locations</div>
              </button>
              {showAgeDetail && (
                <div className="mt-3 rounded-lg bg-purple-50 border border-purple-100 p-3 space-y-2">
                  <div>
                    <div className="text-[11px] font-medium text-gray-500 mb-1">Most popular days</div>
                    <div className="flex flex-wrap gap-1">
                      {topAgeInsight.topDays.map((d) => (
                        <span key={d} className="px-2 py-0.5 text-xs rounded-full bg-white text-purple-700 border border-purple-200">{d}</span>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] font-medium text-gray-500 mb-1">Most popular times</div>
                    <div className="flex flex-wrap gap-1">
                      {topAgeInsight.topTimes.map((t) => (
                        <span key={t} className="px-2 py-0.5 text-xs rounded-full bg-white text-purple-700 border border-purple-200">{t}</span>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] font-medium text-gray-500 mb-1">Top locations</div>
                    <div className="flex flex-wrap gap-1">
                      {topAgeInsight.topLocations.map((l) => (
                        <span key={l} className="px-2 py-0.5 text-xs rounded-full bg-white text-purple-700 border border-purple-200">{l}</span>
                      ))}
                    </div>
                  </div>
                  <p className="text-[11px] text-gray-500 pt-1">
                    Demand for <span className="font-medium">{topAgeInsight.ageGroup}</span> classes is strongest on {topAgeInsight.topDays[0]} mornings — consider adding slots here.
                  </p>
                </div>
              )}
            </div>
            <div className="mb-4">
              <div className="text-xs text-gray-500 mb-2">Bookings by day</div>
              <div className="flex items-end gap-2 h-24">
                {barChartData.map((bar) => (
                  <div key={bar.day} className="flex-1 flex flex-col items-center gap-1">
                    <div
                      className={cn(
                        'w-full rounded-t-sm',
                        bar.day === 'Sat' ? 'bg-purple-500' : 'bg-purple-200'
                      )}
                      style={{ height: `${bar.height}%` }}
                    />
                    <span className="text-xs text-gray-500">{bar.day}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-2 text-sm text-gray-700">
              <Sun className="w-4 h-4 text-yellow-500" />
              <span className="font-medium">Busiest: Sat AM</span>
            </div>
          </div>
        </div>
      </div>

      {/* Floating Chat Button */}
      <button
        onClick={() => setShowMessages(!showMessages)}
        className="fixed bottom-6 right-6 w-14 h-14 bg-gradient-to-br from-[#E91E63] to-[#FF5722] rounded-full flex items-center justify-center shadow-lg hover:shadow-xl transition-shadow z-50"
      >
        <MessageSquare className="w-6 h-6 text-white" />
        <span className="absolute -top-1 -right-1 w-5 h-5 bg-[#E91E63] text-white text-xs rounded-full flex items-center justify-center border-2 border-white">
          {showMessages ? 2 : 7}
        </span>
      </button>

      {/* Messages Drawer */}
      {showMessages && (
        <div className="fixed top-0 right-0 w-96 h-full bg-white shadow-2xl border-l border-gray-200 z-40 animate-slide-in-right flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between p-5 border-b border-gray-200">
            <div className="flex items-center gap-2">
              <h3 className="font-semibold text-gray-900">Messages</h3>
              <span className="w-5 h-5 bg-[#E91E63] text-white text-xs rounded-full flex items-center justify-center">2</span>
            </div>
            <div className="flex items-center gap-2">
              <button className="p-1.5 hover:bg-gray-100 rounded-lg">
                <Edit3 className="w-4 h-4 text-gray-600" />
              </button>
              <button onClick={() => setShowMessages(false)} className="p-1.5 hover:bg-gray-100 rounded-lg">
                <X className="w-4 h-4 text-gray-600" />
              </button>
            </div>
          </div>

          {/* Search */}
          <div className="p-4 border-b border-gray-200">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search messages..."
                className="w-full pl-10 pr-4 py-2.5 bg-gray-50 rounded-xl text-sm border-0 focus:outline-none focus:ring-2 focus:ring-pink-200"
              />
              <SlidersHorizontal className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            </div>
          </div>

          {/* Message List */}
          <div className="flex-1 overflow-auto">
            {messages.map((msg, idx) => (
              <div key={idx} className="flex items-start gap-3 p-4 hover:bg-gray-50 cursor-pointer border-b border-gray-100">
                <div className={cn('w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0', msg.color)}>
                  {msg.initials}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between mb-0.5">
                    <span className="font-medium text-gray-900 text-sm">{msg.name}</span>
                    <span className="text-xs text-gray-500">{msg.time}</span>
                  </div>
                  <p className="text-sm text-gray-600 truncate">{msg.message}</p>
                </div>
                {msg.count > 0 && (
                  <span className="w-5 h-5 bg-[#E91E63] text-white text-xs rounded-full flex items-center justify-center flex-shrink-0">
                    {msg.count}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
