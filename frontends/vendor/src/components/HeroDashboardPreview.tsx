import {
  Search,
  Plus,
  RefreshCw,
  ChevronDown,
  CalendarDays,
  Users,
  MessageSquare,
  UserPlus,
  DollarSign,
  Sparkles,
} from 'lucide-react';

/**
 * Static, illustrative stand-in for the vendor portal (Bookings, Schedule,
 * Messages, Dashboard) used only on the public marketing landing page — a
 * staggered "product screenshot" collage, not live data. Built entirely in
 * JSX (not screenshot crops) so every label stays under our control — never
 * "[DEMO] ..." — since a prospective vendor sees this before ever signing
 * up. All four cards are one uniform size in a diagonal cascade with equal
 * spacing — this arrangement is locked in, don't resize/reposition it.
 * Values (stat numbers, activity names) are matched to the real app
 * screenshots wherever they don't require showing "[DEMO]" text; each card
 * also carries the secondary "side panel" content its real page has
 * (Bookings' detail view, Messages' open thread), not just the list view.
 */

const bookingRows = [
  { name: 'Alfie', status: 'Unpaid' },
  { name: 'Maya', status: 'Paid' },
];

// Computed at load, not hardcoded, so this never reads as a stale past
// date on the marketing page — always "today" for whoever's viewing it.
const today = new Date();
const todayShort = `${today.toLocaleDateString('en-US', { weekday: 'short' })}, ${today.getDate()} ${today.toLocaleDateString('en-US', { month: 'short' })}, 11:45 am`;
const bookingBlurb = `Tinkers Playdate · ${todayShort}`;

const conversations = [
  { name: 'Sarah Tan', preview: 'Anyone want a coffee after class tomorrow?' },
  { name: 'Wei Jie', preview: 'Thanks so much, see you Saturday!' },
];

const statTiles = [
  { icon: CalendarDays, label: 'Bookings', value: '10', color: 'text-pink-600', bg: 'bg-pink-100' },
  { icon: Users, label: 'Attendance', value: '93%', color: 'text-purple-600', bg: 'bg-purple-100' },
  { icon: MessageSquare, label: 'Messages', value: '2', color: 'text-yellow-600', bg: 'bg-yellow-100' },
  { icon: UserPlus, label: 'Waitlist', value: '0', color: 'text-blue-600', bg: 'bg-blue-100' },
  { icon: DollarSign, label: 'Revenue', value: '$381', color: 'text-green-600', bg: 'bg-green-100' },
];


// One uniform size + a consistent diagonal stagger for every card — locked
// in per the approved reference arrangement. Card height is derived from
// width via aspect-ratio, and mobile's narrower width leaves too little
// height for this much content at the desktop ratio — so mobile gets a
// taller ratio (still uniform across all four cards) purely to avoid
// clipping; sm+ keeps the approved 253:159 shape.
const CARD_CLASS =
  'absolute w-[55%] aspect-[3/4] sm:aspect-[253/159] overflow-hidden rounded-xl border-2 border-gray-300 bg-white p-3 shadow-[0_12px_28px_-10px_rgba(15,23,42,0.22)]';
// Left/top steps are sized so the last card's far edge lands at the
// container's edge — the cascade fills the box instead of leaving a dead
// margin on the right/bottom. The vertical step has two competing limits
// per breakpoint: it must stay tall enough to clear the previous card's
// content — for the Bookings card specifically that's title + subheading
// + the highlighted booking row (~65px), the tallest of any card's header
// block, since it's the one every other step has to clear — yet short
// enough that 3 steps + one card's height doesn't exceed the container.
// Card height (via the aspect-ratio) and the container's own height both
// change per breakpoint, so each needs its own calibrated step.
const POSITIONS = [
  'left-0 top-0',
  'left-[15%] top-[15%] sm:top-[15.5%] lg:top-[16%]',
  'left-[30%] top-[30%] sm:top-[31%] lg:top-[32%]',
  'left-[45%] top-[45%] sm:top-[46.5%] lg:top-[48%]',
];

export function HeroDashboardPreview() {
  return (
    <div
      data-testid="hero-dashboard-preview"
      className="relative mx-auto h-[480px] w-full max-w-3xl sm:h-[470px] lg:h-[440px]"
      aria-hidden="true"
    >
      {/* Bookings card — list (left) + the real page's detail side panel (right) */}
      <div className={`${CARD_CLASS} ${POSITIONS[0]}`}>
        <div className="mb-0.5">
          <div className="text-[13px] font-bold text-gray-900">Bookings</div>
          <div className="text-[9.5px] font-medium text-gray-500 whitespace-nowrap">
            <span className="sm:hidden">Manage your bookings</span>
            <span className="hidden sm:inline">Manage bookings for your sessions</span>
          </div>
        </div>
        <div className="mb-1 flex items-center justify-between gap-2 rounded-md border border-gray-100 bg-gray-50 px-2 py-0">
          <span className="truncate text-[8.5px] text-gray-600">
            <span className="sm:hidden">{todayShort}</span>
            <span className="hidden sm:inline">{bookingBlurb}</span>
          </span>
          <span className="flex items-center gap-0.5 whitespace-nowrap text-[8.5px] font-semibold text-[#FA4D8D]">
            <Plus className="h-2.5 w-2.5" /> Add
          </span>
        </div>
        <div className="flex gap-3">
          <div className="w-full space-y-1 sm:w-[55%]">
            {bookingRows.map((row, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <div className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full text-[8px] font-semibold ${
                  ['bg-pink-100 text-pink-700', 'bg-blue-100 text-blue-700'][i]
                }`}>
                  {row.name[0]}
                </div>
                <div className="min-w-0 flex-1 truncate text-[8.5px] font-medium text-gray-800">{row.name}</div>
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
          {/* Side panel: the real page's booking-detail view (hidden on the
              smallest screens — the card doesn't have room for it there). */}
          <div className="hidden w-[45%] rounded-md border border-gray-100 bg-gray-50 p-1.5 sm:block">
            <div className="mb-0.5 flex items-center gap-1">
              <div className="flex h-4 w-4 items-center justify-center rounded-full bg-pink-100 text-[6.5px] font-semibold text-pink-700">A</div>
              <div className="text-[8px] font-semibold text-gray-900">Alfie</div>
            </div>
            <div className="text-[6.5px] text-gray-400">Payment</div>
            <div className="text-[7px] font-medium text-gray-700">None</div>
          </div>
        </div>
      </div>

      {/* Schedule card */}
      <div className={`${CARD_CLASS} ${POSITIONS[1]}`}>
        <div className="mb-1.5 flex items-start justify-between">
          <div>
            <div className="text-[13px] font-bold text-gray-900">Schedule</div>
            <div className="text-[9.5px] font-medium text-gray-500 whitespace-nowrap">
              <span className="sm:hidden">Live Wix availability</span>
              <span className="hidden sm:inline">Site bookings & live Wix availability</span>
            </div>
          </div>
          <RefreshCw className="h-3 w-3 text-gray-300" />
        </div>
        <div className="mb-1.5 flex items-center gap-1.5 text-[8px] text-gray-500">
          <span className="rounded-full border border-gray-200 px-1.5 py-0.5">Today</span>
          <span className="font-semibold text-gray-700">23 – 29 Aug</span>
          <span className="ml-auto flex items-center gap-0.5 rounded-full border border-gray-200 px-1.5 py-0.5">
            All activities <ChevronDown className="h-2.5 w-2.5" />
          </span>
        </div>
        <div className="grid grid-cols-7 gap-1">
          {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
            <div key={i} className="rounded bg-gray-50 py-1 text-center text-[7px] font-medium text-gray-400">
              {d}
            </div>
          ))}
          {['', '1/1', '0/1', '1/10', '0/1', '0/1', '1/10'].map((v, i) => (
            <div
              key={i}
              className={`flex h-8 flex-col items-center justify-center gap-0.5 rounded ${
                i === 1 || i === 3 ? 'bg-pink-100' : 'bg-gray-50'
              }`}
            >
              <span className="text-[7px] font-semibold text-gray-500">{23 + i}</span>
              {v && <span className="text-[6px] font-medium text-gray-500">{v}</span>}
            </div>
          ))}
        </div>
      </div>

      {/* Messages card — conversation list (left) + the real page's open thread (right) */}
      <div className={`${CARD_CLASS} ${POSITIONS[2]}`}>
        <div className="mb-1.5">
          <div className="text-[13px] font-bold text-gray-900">Messages</div>
          <div className="text-[9.5px] font-medium leading-tight text-gray-500">
            Every parent enquiry, across all your services, in one inbox.
          </div>
        </div>
        <div className="flex gap-2">
          <div className="w-full space-y-1.5 sm:w-[38%]">
            <div className="mb-1 flex items-center gap-1 rounded-md border border-gray-100 bg-gray-50 px-1.5 py-1">
              <Search className="h-2 w-2 text-gray-300" />
              <span className="text-[6.5px] text-gray-300">Search</span>
            </div>
            {conversations.map((c, i) => (
              <div key={i} className="flex items-center gap-1">
                <div className={`h-4 w-4 flex-shrink-0 rounded-full ${['bg-purple-100', 'bg-blue-100'][i]}`} />
                <div className="min-w-0 flex-1 truncate text-[7px] font-medium text-gray-800">{c.name}</div>
              </div>
            ))}
          </div>
          {/* Side panel: the real page's open conversation thread (hidden on
              the smallest screens — the card doesn't have room for it there). */}
          <div className="hidden flex-1 rounded-md border border-gray-100 bg-gray-50 p-1.5 sm:block">
            <div className="mb-1 text-[7px] font-semibold text-gray-900">Sarah Tan</div>
            <div className="mb-1 max-w-[90%] rounded-lg rounded-tl-sm bg-white px-1.5 py-1 text-[6.5px] text-gray-700 shadow-sm">
              {conversations[0].preview}
            </div>
            <div className="ml-auto max-w-[90%] rounded-lg rounded-tr-sm bg-[#FEEBF2] px-1.5 py-1 text-[6.5px] text-gray-700">
              {conversations[1].preview}
            </div>
          </div>
        </div>
      </div>

      {/* Dashboard summary card — same uniform size as the rest, last in
          DOM order so it's the unobstructed front layer. */}
      <div className={`${CARD_CLASS} ${POSITIONS[3]} shadow-[0_18px_40px_-12px_rgba(15,23,42,0.30)]`}>
        <div className="mb-1 flex items-center gap-1">
          <span className="text-[13px] font-bold text-gray-900">Good morning! 👋</span>
          <Sparkles className="h-3 w-3 text-yellow-400" />
        </div>
        <div className="mb-1 text-[9.5px] font-medium text-gray-500 whitespace-nowrap">
          <span className="sm:hidden">What's happening today</span>
          <span className="hidden sm:inline">Here's what's happening today</span>
        </div>
        <div className="mb-1.5 grid grid-cols-5 gap-1">
          {statTiles.map((s, i) => (
            <div key={i} className="rounded-md bg-gray-50 p-1 text-center">
              <div className={`mx-auto mb-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full ${s.bg}`}>
                <s.icon className={`h-2 w-2 ${s.color}`} />
              </div>
              <div className="text-[9.5px] font-bold text-gray-900">{s.value}</div>
              <div className="hidden break-words text-[6.5px] leading-[7px] text-gray-400 sm:block">{s.label}</div>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-1 gap-1 sm:grid-cols-3 sm:gap-1.5">
          {/* Upcoming Sessions */}
          <div className="rounded-md bg-gray-50 p-1 sm:p-1.5">
            <div className="mb-1 flex items-center justify-between gap-0.5 sm:mb-1.5">
              <span className="truncate text-[7px] font-bold text-gray-900">Upcoming Sessions</span>
              <span className="flex-shrink-0 text-[6.5px] font-semibold text-[#FA4D8D]">View all</span>
            </div>
            <div className="space-y-1 sm:space-y-1.5">
              {[
                { name: 'Tinkers Playdate', booked: '5 / 20' },
                { name: 'Hatha Yoga', booked: '1 / 1' },
              ].map((s, i) => (
                <div key={i} className={`items-center gap-1 ${i === 0 ? 'flex' : 'hidden sm:flex'}`}>
                  <div className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded bg-pink-100">
                    <CalendarDays className="h-2 w-2 text-pink-600" />
                  </div>
                  <div className="min-w-0 flex-1 truncate text-[6.5px] font-medium text-gray-800">{s.name}</div>
                  <div className="flex-shrink-0 text-[6px] font-semibold text-gray-900">{s.booked}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Recent Bookings */}
          <div className="rounded-md bg-gray-50 p-1 sm:p-1.5">
            <div className="mb-1 flex items-center justify-between gap-0.5 sm:mb-1.5">
              <span className="truncate text-[7px] font-bold text-gray-900">Recent Bookings</span>
              <span className="flex-shrink-0 text-[6.5px] font-semibold text-[#FA4D8D]">View all</span>
            </div>
            <div className="space-y-1 sm:space-y-1.5">
              {[
                { initial: 'L', name: 'Lorelei' },
                { initial: 'M', name: 'Madhav' },
              ].map((b, i) => (
                <div key={i} className={`items-center gap-1 ${i === 0 ? 'flex' : 'hidden sm:flex'}`}>
                  <div className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full text-[5.5px] font-bold ${
                    ['bg-pink-100 text-pink-700', 'bg-purple-100 text-purple-700'][i]
                  }`}>
                    {b.initial}
                  </div>
                  <div className="min-w-0 flex-1 truncate text-[6.5px] font-medium text-gray-800">{b.name}</div>
                  <span className="flex-shrink-0 rounded-full bg-green-100 px-1 py-0.5 text-[5px] font-medium text-green-700">
                    Confirmed
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Insights */}
          <div className="rounded-md bg-gray-50 p-1 sm:p-1.5">
            <div className="mb-1 text-[7px] font-bold text-gray-900 sm:mb-1.5">Insights</div>
            <div className="text-[6px] leading-[8px] text-gray-500">
              Which classes convert, which age groups book, and the days parents choose.
            </div>
            <div className="mt-1 text-[6.5px] font-semibold text-[#FA4D8D] sm:mt-1.5">Open Insights →</div>
          </div>
        </div>
      </div>
    </div>
  );
}
