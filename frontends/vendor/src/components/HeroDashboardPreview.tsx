import {
  Search,
  Plus,
  CalendarDays,
  RefreshCw,
  ChevronDown,
  MessageSquare,
  DollarSign,
  Users,
  UserPlus,
  Sparkles,
} from 'lucide-react';

/**
 * Static, illustrative stand-in for the vendor portal (Bookings, Schedule,
 * Messages, Dashboard) used only on the public marketing landing page — a
 * staggered "product screenshot" collage, not live data. Every value here is
 * fixed sample content; deliberately free of "Demo"/placeholder-looking
 * labels since a real vendor sees this before ever signing up.
 */

const bookingRows = [
  { name: 'Alfie', meta: '11 months · Toddler Music', status: 'Unpaid' },
  { name: 'Maya', meta: '2 years · Toddler Music', status: 'Paid' },
  { name: 'Ravi', meta: '18 months · Toddler Music', status: 'Unpaid' },
];

const conversations = [
  { name: 'Sarah Tan', preview: 'Anyone want a coffee after class tomorrow?' },
  { name: 'Wei Jie', preview: 'Thanks so much, see you Saturday!' },
  { name: 'Priya Kumar', preview: 'Is there a makeup session this week?' },
];

const statTiles = [
  { icon: CalendarDays, label: 'Bookings', value: '9', color: 'text-pink-600', bg: 'bg-pink-100' },
  { icon: Users, label: 'Attendance', value: '70%', color: 'text-purple-600', bg: 'bg-purple-100' },
  { icon: MessageSquare, label: 'Messages', value: '0', color: 'text-yellow-600', bg: 'bg-yellow-100' },
  { icon: UserPlus, label: 'Waitlist', value: '0', color: 'text-blue-600', bg: 'bg-blue-100' },
  { icon: DollarSign, label: 'Revenue', value: '$81', color: 'text-green-600', bg: 'bg-green-100' },
];

export function HeroDashboardPreview() {
  return (
    <div
      data-testid="hero-dashboard-preview"
      className="relative mx-auto h-[300px] w-full max-w-xl sm:h-[340px] lg:h-[380px]"
      aria-hidden="true"
    >
      {/* Bookings card */}
      <div className="absolute left-0 top-0 w-[46%] rounded-xl border border-gray-200 bg-white p-3 shadow-[0_12px_28px_-10px_rgba(15,23,42,0.22)]">
        <div className="mb-2">
          <div className="text-[13px] font-bold text-gray-900">Bookings</div>
          <div className="text-[9px] text-gray-400">Manage bookings for your sessions</div>
        </div>
        <div className="mb-2 flex items-center justify-between gap-2 rounded-md border border-gray-100 bg-gray-50 px-2 py-1">
          <span className="truncate text-[9px] text-gray-600">Toddler Music · Mon, 24 Aug, 11:45 am</span>
          <span className="flex items-center gap-0.5 whitespace-nowrap text-[9px] font-semibold text-[#C90044]">
            <Plus className="h-2.5 w-2.5" /> Add
          </span>
        </div>
        <div className="mb-2 flex gap-3 border-b border-gray-100 text-[9px] font-medium text-gray-400">
          <span className="border-b-2 border-[#C90044] pb-1 text-[#C90044]">Bookings</span>
          <span className="pb-1">Waitlist</span>
          <span className="pb-1">Attendance</span>
        </div>
        <div className="space-y-1.5">
          {bookingRows.map((row, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-pink-100 text-[8px] font-semibold text-pink-700">
                {row.name[0]}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[9px] font-medium text-gray-800">{row.name}</div>
                <div className="truncate text-[8px] text-gray-400">{row.meta}</div>
              </div>
              <span
                className={`whitespace-nowrap rounded-full px-1.5 py-0.5 text-[7px] font-semibold ${
                  row.status === 'Paid' ? 'bg-green-50 text-green-600' : 'bg-red-50 text-red-500'
                }`}
              >
                {row.status}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Schedule card */}
      <div className="absolute left-[16%] top-[15%] w-[46%] rounded-xl border border-gray-200 bg-white p-3 shadow-[0_12px_28px_-10px_rgba(15,23,42,0.22)]">
        <div className="mb-2 flex items-start justify-between">
          <div>
            <div className="text-[13px] font-bold text-gray-900">Schedule</div>
            <div className="text-[9px] text-gray-400">Every upcoming session, site-wide</div>
          </div>
          <RefreshCw className="h-3 w-3 text-gray-300" />
        </div>
        <div className="mb-2 flex items-center gap-1.5 text-[8px] text-gray-500">
          <span className="rounded-full border border-gray-200 px-1.5 py-0.5">Today</span>
          <span className="font-semibold text-gray-700">August 2026</span>
          <span className="ml-auto flex items-center gap-0.5 rounded-full border border-gray-200 px-1.5 py-0.5">
            All activities <ChevronDown className="h-2.5 w-2.5" />
          </span>
        </div>
        <div className="mb-2 grid grid-cols-7 gap-1">
          {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
            <div key={i} className="rounded bg-gray-50 py-1 text-center text-[7px] font-medium text-gray-400">
              {d}
            </div>
          ))}
          {[...Array(7)].map((_, i) => (
            <div
              key={i}
              className={`flex h-10 flex-col items-center justify-center gap-0.5 rounded ${
                i === 2 || i === 4 ? 'bg-pink-100' : 'bg-gray-50'
              }`}
            >
              <span className="text-[7px] font-semibold text-gray-500">{18 + i}</span>
              {(i === 2 || i === 4) && <span className="h-1 w-3 rounded-full bg-[#C90044]" />}
            </div>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1 text-[7px] text-gray-500">
            <span className="h-1.5 w-1.5 rounded-full bg-[#C90044]" /> Toddler Music
          </span>
          <span className="flex items-center gap-1 text-[7px] text-gray-500">
            <span className="h-1.5 w-1.5 rounded-full bg-purple-400" /> Ballet Basics
          </span>
        </div>
      </div>

      {/* Messages card */}
      <div className="absolute left-[38%] top-[28%] w-[46%] rounded-xl border border-gray-200 bg-white p-3 shadow-[0_12px_28px_-10px_rgba(15,23,42,0.22)]">
        <div className="mb-2">
          <div className="text-[13px] font-bold text-gray-900">Messages</div>
          <div className="text-[9px] text-gray-400">Parents and providers, one inbox</div>
        </div>
        <div className="mb-2 flex items-center gap-1.5 rounded-md border border-gray-100 bg-gray-50 px-2 py-1">
          <Search className="h-2.5 w-2.5 text-gray-300" />
          <span className="text-[8px] text-gray-300">Search conversations</span>
        </div>
        <div className="space-y-2">
          {conversations.map((c, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <div className="h-5 w-5 flex-shrink-0 rounded-full bg-purple-100" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[8.5px] font-medium text-gray-800">{c.name}</div>
                <div className="truncate text-[7.5px] text-gray-400">{c.preview}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Dashboard summary card */}
      <div className="absolute bottom-0 right-0 w-[58%] rounded-xl border border-gray-200 bg-white p-3 shadow-[0_18px_40px_-12px_rgba(15,23,42,0.30)]">
        <div className="mb-2 flex items-center gap-1">
          <span className="text-[13px] font-bold text-gray-900">Good morning! 👋</span>
          <Sparkles className="h-3 w-3 text-yellow-400" />
        </div>
        <div className="grid grid-cols-5 gap-1.5">
          {statTiles.map((s, i) => (
            <div key={i} className="rounded-md bg-gray-50 p-1.5 text-center">
              <div className={`mx-auto mb-1 flex h-4 w-4 items-center justify-center rounded-full ${s.bg}`}>
                <s.icon className={`h-2.5 w-2.5 ${s.color}`} />
              </div>
              <div className="text-[9px] font-bold text-gray-900">{s.value}</div>
              <div className="truncate text-[6.5px] text-gray-400">{s.label}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
