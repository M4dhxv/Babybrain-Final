import { createPortal } from "react-dom";
import { staffLabel } from "../lib/staffLabel";
import {
  Suspense,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  ActivityCard,
  AnimalAvatar,
  Button,
  CategoryTile,
  DateInput,
  Footer,
  Icon,
  PageShell,
  SectionTitle,
  fallbackToPlaceholder,
  ACTIVITY_PLACEHOLDER_URL,
} from "../components/ui";
import { AvatarPicker } from "../components/AvatarPicker";
import { SelectField, Opt } from "../components/SelectField";
import { UnreadBadge } from "../components/UnreadBadge";
import RedirectToLanding from "../components/RedirectToLanding";
import {
  ActivityCardGridSkeleton,
  JourneyStatsSkeleton,
  ListRowsSkeleton,
  MessagesSkeleton,
} from "../components/Skeletons";
import { useAuth } from "../auth/AuthProvider";
import { useUnreadMessages } from "../lib/chat";
import { supabase } from "../lib/supabase";
import { cacheFetch, cacheInvalidate } from "../lib/queryCache";
import { apiGet, apiPost } from "../lib/api";
import { cleanRpcErrorMessage } from "../lib/errors";
import { goTo, getParam, scrollHighlightIntoView } from "../lib/nav";
import { sgDateTime, sgDay, sgDayRange } from "../lib/schedule";
import { downloadBookingIcs, downloadScheduleIcs } from "../lib/ics";
import { downloadSchedulePdf, withinRange } from "../lib/schedule-pdf";
import {
  usePlan,
  useRecommendations,
  useJourney,
  invalidatePlan,
  primePlan,
  toCard,
} from "../lib/data";
import { formatChildAge } from "../lib/database.types";
import type { Child, Gender } from "../lib/database.types";
import { CHILD_AVATARS } from "../lib/avatars";
import { dobError } from "../lib/validation";
import { Chip } from "./prefChips";
import { lazyRoute } from "../lib/lazyRoute";
import { isStandalone } from "../lib/install";
import { getPushState, subscribeToPush, unsubscribeFromPush, type PushState } from "../lib/push";

const MessagesTab = lazyRoute(
  () => import("../components/MessagesTab").then((m) => ({ default: m.MessagesTab })),
  "MessagesTab"
);

// How long ProfilePage's own reads (favourites, reviews, notifications,
// packages, tokens, saved providers) stay usable without a refetch — matches
// useActivities's FRESH_MS. Every write path that touches one of these
// tables calls cacheInvalidate on its key, so this is purely about cutting
// repeat-visit/duplicate-mount fetches, not risking stale-after-your-own-edit.
const PROFILE_FRESH_MS = 60_000;

type BookingItem = {
  id: string; status: string; when: string; title: string; slug: string; image: string;
  startsAt: string | null; endsAt: string | null; venue: string;
  /** Teacher and/or studio for this session, when the vendor set them (00074). */
  staff: string;
  activityId: string | null; childId: string | null; packagePurchaseId: string | null;
  allowCancel: boolean; allowReschedule: boolean;
  cancelCutoffH: number; resCutoffH: number;
  // Set once the vendor removes the activity (unlinkWixActivities stamps
  // wix_removed_at) — its own detail page is gone, so booking cards for it
  // route back to the activities list instead of a dead link.
  removed: boolean;
  // For a cancelled booking: how it was made good (00080). 'token' = an
  // auto make-up token was issued; 'credit' = a package credit went back;
  // 'none' = the provider withheld a refund (00099).
  compensation: "token" | "credit" | "none" | null;
  // What paid for this booking — drives the cancel-confirm heads-up.
  paidWith: "token" | "credit" | "cash" | "free";
  // What this class gives back on cancellation (00099): 'none' = payment is
  // non-refundable if cancelled.
  refundMode: "refund" | "none";
  // A waitlisted booking on a paid class that now has a seat free for it
  // (00100) — the card shows "Pay now" to claim it. Recomputed every load,
  // so it disappears the moment the seat is taken. `claimIds` are the seat
  // rows to check out.
  canClaim: boolean;
  claimIds: string[];
  // A Wix ticketed event — parents can't cancel or reschedule these online.
  isEvent: boolean;
  // A Wix COURSE — one enrolment covers the whole run, so there's no single
  // session to move it to; reschedule is blocked.
  isCourse: boolean;
  // Linked to a real Wix Bookings service — cancel must also tell Wix (see
  // /api/wix/bookings/cancel), or the seat stays "taken" there forever.
  isWixLinked: boolean;
  // Wix-linked AND a CLASS specifically — reschedule must also tell Wix (see
  // /api/wix/bookings/reschedule). Not APPOINTMENT/COURSE: see that route's
  // own doc for why those stay local-only for now.
  isWixClass: boolean;
  // A multi-child booking (00084): every seat is its own booking row sharing
  // one booking_group_id, collapsed here into a single card. `places` lists
  // them in seat order — seat 1 is the chosen child, the rest are guests
  // ("Guest child" until renamed). `allIds` drives group reschedule; cancel
  // uses `groupId`.
  groupId: string | null;
  places: { bookingId: string; name: string; isGuest: boolean; status: string }[];
  allIds: string[];
  // Per live seat, e.g. ["confirmed","confirmed","waitlisted"] — a party can
  // straddle a session's capacity, so the seats don't all share `status`.
  seatStatuses: string[];
};
type ReviewItem = { id: string; rating: number; comment: string | null; title: string; slug: string; providerResponse: string | null };
/** `data` is deliberately untyped (jsonb, shape varies by `type` — see
 *  notificationTarget below, which is the one place that reads into it). */
type NotifItem = { id: string; type: string; title: string; body: string; read_at: string | null; created_at: string; data: Record<string, unknown> };

/** One suggested activity inside a 'suggested_activities' notification's
 *  `data.activities` — the shape session_email_details/toLiveActivity-adjacent
 *  code on the backend builds (see 00120_suggested_activities_digest.sql). */
type SuggestedActivity = { activity_name?: string; date_time?: string; url?: string };

/** Where tapping a notification should go, and (for a booking/token/package
 *  one) which row on the destination tab to flash so the parent can find the
 *  thing that changed instead of scanning a whole list.
 *
 *  Every notification type already carries `booking_id` / `token_id` /
 *  `package_purchase_id` in its `data` (see the various `insert into
 *  public.notifications` call sites across supabase/migrations) — this just
 *  reads them back out. Falls back to the plain `data.url` (a digest with
 *  nothing specific to highlight, e.g. suggested_activities' own container
 *  notification) when none of the specific ids are present. */

function notificationTarget(n: NotifItem): string | null {
  const d = n.data ?? {};
  const bookingId = typeof d.booking_id === "string" ? d.booking_id : null;
  const tokenId = typeof d.token_id === "string" ? d.token_id : null;
  const packageId = typeof d.package_purchase_id === "string" ? d.package_purchase_id : null;
  const url = typeof d.url === "string" ? d.url : null;

  // A deep link straight into checkout (e.g. "/book?slug=...&token=...") is
  // already more useful than sending the parent to a list to go find the
  // thing themselves — keep it as-is, no highlight needed since it's the
  // only thing on that page.
  if (url && !url.startsWith("/profile?tab=")) return url;

  if (packageId) return `/profile?tab=packages&highlight=${encodeURIComponent(packageId)}`;
  if (tokenId) return `/profile?tab=makeup&highlight=${encodeURIComponent(tokenId)}`;
  if (bookingId) return `/profile?tab=bookings&highlight=${encodeURIComponent(bookingId)}`;
  return url;
}

/** One row on the Notifications tab. Most types resolve to a single link (see
 *  notificationTarget); 'suggested_activities' is different — its `data`
 *  holds up to 5 activities rather than one target, so it opens as a small
 *  dropdown of links instead of navigating the whole card. */
function NotificationRow({ n }: { n: NotifItem }) {
  const [open, setOpen] = useState(false);
  const activities =
    n.type === "suggested_activities" && Array.isArray(n.data?.activities)
      ? (n.data.activities as SuggestedActivity[])
      : null;
  const target = activities ? null : notificationTarget(n);
  const cardClass = `rounded-[12px] border p-4 shadow-card ${n.read_at ? "border-[#EBE3E5] bg-white" : "border-[#DAEEFB] bg-[#FFF5F8]"}`;

  const body = (
    <div className="flex items-start gap-2">
      {!n.read_at && <span className="mt-1.5 h-2 w-2 flex-shrink-0 rounded-full bg-baby-pink" />}
      <div className="min-w-0 flex-1">
        <p className="font-black">{n.title}</p>
        {n.body && <p className="mt-0.5 text-sm font-semibold text-[#59658d]">{n.body}</p>}
        <p className="mt-1 text-xs font-semibold text-[#6D748A]">{sgDateTime(n.created_at)}</p>
      </div>
      {target && <Icon name="chevron" className="mt-1 h-4 w-4 flex-shrink-0 text-[#9AA2BD]" />}
    </div>
  );

  if (activities) {
    return (
      <div className={cardClass}>
        {body}
        {activities.length > 0 && (
          <>
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              className="mt-3 flex items-center gap-1.5 text-xs font-black text-baby-cta"
            >
              <Icon name="chevron" className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
              {open ? "Hide activities" : `View ${activities.length} ${activities.length === 1 ? "activity" : "activities"}`}
            </button>
            {open && (
              <div className="mt-2 space-y-1 border-t border-[#F4EFF0] pt-2.5">
                {activities.map((a, i) => (
                  <a
                    key={i}
                    href={a.url ?? "/explore"}
                    className="block rounded-[8px] px-2 py-1.5 text-sm font-bold text-[#34406f] hover:bg-palette-pinkTint"
                  >
                    {a.activity_name ?? "Activity"}
                    {a.date_time && <span className="ml-1.5 font-semibold text-[#6D748A]">· {a.date_time}</span>}
                  </a>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  if (target) {
    return (
      <a href={target} className={`block ${cardClass} transition hover:border-baby-pink`}>
        {body}
      </a>
    );
  }

  return <div className={cardClass}>{body}</div>;
}
type TokenItem = { id: string; status: string; provider: string; activityTitle: string | null; created_at: string; expires_at: string | null; originSlug: string | null; childId: string | null };
type PackageItem = { id: string; name: string; provider: string; total: number; remaining: number; status: string; expiresAt: string | null; bookHref: string };

/** [key, label, icon, plusOnly] — the Plus-only tabs are the ones QA listed as
 *  needing to differ between tiers (packages, make-up tokens, favourites). */
const PROFILE_TABS: [string, string, string, boolean][] = [
  ["overview", "Overview", "home", false],
  ["children", "My children", "people", false],
  ["bookings", "Bookings", "calendar", false],
  ["past", "Past activities", "check", false],
  // Packages sits above make-up tokens: parents reach for a pack far more
  // often than a token, so it reads better in that order.
  ["packages", "Packages", "store", true],
  ["makeup", "Make-up tokens", "gift", true],
  ["favorites", "Favourites", "heart", true],
  ["messages", "Messages", "chat", true],
  ["reviews", "Reviews", "star", false],
  ["notifications", "Notifications", "bell", false],
  ["settings", "Settings", "gear", false],
];

/** Pick a date range, then export those bookings as a printable PDF or an
 *  .ics calendar file.
 *
 *  The exports used to take everything at once, which is unhelpful once a
 *  parent has a term's worth of classes — QA asked to "choose a range before
 *  download". Presets cover the common cases; the two date fields (which carry
 *  their own calendar pop-out) handle anything else. */
function ExportScheduleDialog({
  items,
  parentName,
  onClose,
}: {
  items: BookingItem[];
  parentName?: string;
  onClose: () => void;
}) {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const addDays = (n: number) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return iso(d);
  };
  const [from, setFrom] = useState(iso(new Date()));
  const [to, setTo] = useState(addDays(30));

  const presets: [string, string, string][] = [
    ["Next 7 days", iso(new Date()), addDays(7)],
    ["Next 30 days", iso(new Date()), addDays(30)],
    ["Next 3 months", iso(new Date()), addDays(90)],
    ["Everything", "", ""],
  ];

  const entries = items
    .filter((b) => b.startsAt && b.status !== "cancelled")
    .map((b) => ({
      title: b.title,
      startsAt: b.startsAt!,
      endsAt: b.endsAt,
      venue: b.venue,
      status: b.status,
    }));
  const selected = withinRange(entries, { from: from || null, to: to || null });
  const invalid = from && to && from > to;

  const input = "h-11 w-full rounded-[10px] border border-[#FED7E4] px-3 text-sm font-semibold";

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-label="Export schedule"
        className="w-full max-w-[420px] rounded-[16px] bg-white p-5 shadow-soft"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-black">Export your schedule</h2>
            <p className="mt-1 text-sm font-semibold text-[#59658d]">
              Choose a date range, then save it as a PDF or add it to your calendar.
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="shrink-0 rounded-full p-1 text-[#6D748A] hover:bg-[#FAF7F7]">
            <Icon name="close" className="h-5 w-5" />
          </button>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {presets.map(([label, f, t]) => {
            const on = from === f && to === t;
            return (
              <button
                key={label}
                type="button"
                onClick={() => { setFrom(f); setTo(t); }}
                className={`rounded-full px-3 py-1.5 text-xs font-bold transition ${
                  on ? "bg-baby-pink text-white" : "border border-[#EBE3E5] text-[#59658d] hover:border-baby-pink"
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs font-black">From</span>
            <DateInput value={from} onChange={setFrom} className={input} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-black">To</span>
            <DateInput value={to} onChange={setTo} className={input} />
          </label>
        </div>

        <p className={`mt-3 text-sm font-bold ${invalid ? "text-[#FFC1D6]" : "text-[#59658d]"}`}>
          {invalid
            ? "The end date is before the start date."
            : `${selected.length} ${selected.length === 1 ? "class" : "classes"} in this range`}
        </p>

        <div className="mt-4 flex gap-3">
          <Button
            type="button"
            disabled={!!invalid || selected.length === 0}
            onClick={() => {
              downloadSchedulePdf(entries, parentName, { from: from || null, to: to || null });
              onClose();
            }}
            className="flex-1 justify-center"
          >
            <Icon name="open" className="h-4 w-4" /> Save as PDF
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!!invalid || selected.length === 0}
            onClick={() => {
              downloadScheduleIcs(
                selected.map((e, i) => ({
                  id: `${i}-${e.startsAt}`,
                  title: e.title,
                  startsAt: e.startsAt,
                  endsAt: e.endsAt ?? null,
                  venue: e.venue,
                }))
              );
              onClose();
            }}
            className="flex-1 justify-center"
          >
            <Icon name="calendar" className="h-4 w-4" /> Calendar
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Blurred behind the Saved-activities upsell on Free, so the section shows
 *  the shape of the feature without leaking a parent's real shortlist. */
const PLACEHOLDER_SAVED = [
  { id: "ph-1", slug: "", title: "Music & Movement", category: "Music & Drama", image: `${import.meta.env.BASE_URL}assets/crops/activity-play.png`, age: "6 months – 2 years", venue: "Central", date: "", time: "", rating: "" },
  { id: "ph-2", slug: "", title: "Sensory Play", category: "Sensory & Art", image: `${import.meta.env.BASE_URL}assets/crops/activity-play.png`, age: "12 months – 3 years", venue: "East", date: "", time: "", rating: "" },
  { id: "ph-3", slug: "", title: "Toddler Gym", category: "Gym, Dance & Other Sports", image: `${import.meta.env.BASE_URL}assets/crops/activity-play.png`, age: "18 months – 4 years", venue: "West", date: "", time: "", rating: "" },
];

/** Stand-in shown where a Plus-only feature would be, with the upgrade path. */
function PlusLock({ title, copy }: { title: string; copy: string }) {
  return (
    <div className="mt-4 rounded-[14px] border border-dashed border-[#FFC1D6] bg-[#FFF5F8] p-10 text-center">
      <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-[#FED7E4] text-baby-cta">
        <Icon name="lock" className="h-7 w-7" />
      </span>
      <h2 className="mt-4 text-xl font-black">{title}</h2>
      <p className="mx-auto mt-2 max-w-[420px] font-semibold text-[#68718f]">{copy}</p>
      <Button href="/pricing" className="mt-5"><Icon name="star" className="h-4 w-4" /> Upgrade to Plus</Button>
    </div>
  );
}

/** Which child a profile tab is showing.
 *
 *  QA: "If you have more than one child, bookings etc are bundled together —
 *  there should be a drop down under overview, bookings, past activities,
 *  packages, make up tokens, favourites to select which child you want to see
 *  the details for with the option to select both and they are split out."
 *  So: one selector, shared by every tab, and "All children" doesn't merge the
 *  lists — it splits them into a section per child. */
function ChildSelect({
  kids,
  value,
  onChange,
  label = "Showing",
  className,
}: {
  kids: { id: string; name: string }[];
  value: string | null;
  onChange: (id: string | null) => void;
  label?: string;
  /** Replaces the default `mb-4` — pass it when the selector shares a row with
   *  another control, which then owns the spacing. */
  className?: string;
}) {
  if (kids.length < 2) return null;
  return (
    <label className={`flex items-center gap-2 text-sm font-bold text-[#4a5685] ${className ?? "mb-4"}`}>
      {label}
      <SelectField
        value={value ?? "all"}
        onChange={(v) => onChange(v === "all" ? null : v)}
        aria-label={label}
        className={`h-10 px-3 text-sm font-bold text-[#4a5685]${className ? " min-w-0 flex-1" : ""}`}
      >
        <Opt value="all">All children (split out)</Opt>
        {kids.map((k) => (
          <Opt key={k.id} value={k.id}>{k.name}</Opt>
        ))}
      </SelectField>
    </label>
  );
}

type BookingSort = "latest" | "soonest";
const DEFAULT_BOOKING_SORT: BookingSort = "latest";
const BOOKING_STATUS_LABEL: Record<string, string> = {
  confirmed: "Confirmed",
  waitlisted: "Waitlisted",
  pending: "Pending",
  cancelled: "Cancelled",
};

/** How many of the two Bookings controls differ from their defaults — shown as
 *  a count on the Filter button so a narrowed list is never a surprise. */
const bookingFilterCount = (sort: BookingSort, status: string) =>
  (sort !== DEFAULT_BOOKING_SORT ? 1 : 0) + (status !== "all" ? 1 : 0);

/** The Filter button that sits beside the child selector. Icon-only on phones
 *  so the selector keeps its room; the panel it toggles is BookingsFilterPanel,
 *  rendered on its own row underneath. */
function BookingsFilterButton({
  open,
  onToggle,
  active,
}: {
  open: boolean;
  onToggle: () => void;
  active: number;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label="Filter and sort bookings"
      className={`relative flex h-10 shrink-0 items-center gap-2 rounded-[10px] border bg-white px-3 text-sm font-bold text-[#4a5685] ${open ? "border-[#FA4D8D]" : "border-[#EBE3E5]"}`}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
        <circle cx="16" cy="7" r="2" />
        <circle cx="8" cy="17" r="2" />
      </svg>
      <span className="hidden sm:inline">Filter</span>
      {active > 0 && (
        <span className="absolute -right-1.5 -top-1.5 grid h-5 min-w-5 place-items-center rounded-full bg-[#FA4D8D] px-1 text-xs font-black text-white sm:static">
          {active}
        </span>
      )}
    </button>
  );
}

/** Sort and status panel for the Bookings tab. Only offers the statuses the
 *  parent actually has, with how many of each. */
function BookingsFilterPanel({
  sort,
  onSort,
  status,
  onStatus,
  counts,
  total,
}: {
  sort: BookingSort;
  onSort: (s: BookingSort) => void;
  status: string;
  onStatus: (s: string) => void;
  counts: Record<string, number>;
  total: number;
}) {
  const active = bookingFilterCount(sort, status);
  const statuses = Object.keys(BOOKING_STATUS_LABEL).filter((s) => counts[s]);
  const chip = (on: boolean) =>
    `h-9 rounded-full border px-3.5 text-sm font-bold ${on ? "border-[#FA4D8D] bg-[#FED7E4] text-baby-cta" : "border-[#EBE3E5] bg-white text-[#4a5685]"}`;
  return (
    <div className="mb-4 rounded-[14px] border border-[#EBE3E5] bg-white p-4">
      <p className="mb-2 text-xs font-black uppercase tracking-wide text-[#6D748D]">Sort by date</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={chip(sort === "latest")} onClick={() => onSort("latest")}>Latest first</button>
        <button type="button" className={chip(sort === "soonest")} onClick={() => onSort("soonest")}>Earliest first</button>
      </div>
      <p className="mb-2 mt-4 text-xs font-black uppercase tracking-wide text-[#6D748D]">Status</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={chip(status === "all")} onClick={() => onStatus("all")}>All ({total})</button>
        {statuses.map((s) => (
          <button key={s} type="button" className={chip(status === s)} onClick={() => onStatus(s)}>
            {BOOKING_STATUS_LABEL[s]} ({counts[s]})
          </button>
        ))}
      </div>
      {active > 0 && (
        <button
          type="button"
          onClick={() => { onSort(DEFAULT_BOOKING_SORT); onStatus("all"); }}
          className="mt-4 text-sm font-black text-baby-cta"
        >
          Reset
        </button>
      )}
    </div>
  );
}

/** Split a list into one group per child, in the order the children appear.
 *  Anything with no child on it lands in a trailing "Not assigned" group. */
function groupByChild<T extends { childId?: string | null; child_id?: string | null }>(
  items: T[],
  kids: { id: string; name: string }[]
): { key: string; name: string; items: T[] }[] {
  const childOf = (i: T) => i.childId ?? i.child_id ?? null;
  const groups = kids
    .map((k) => ({ key: k.id, name: k.name, items: items.filter((i) => childOf(i) === k.id) }))
    .filter((g) => g.items.length > 0);
  const loose = items.filter((i) => !childOf(i) || !kids.some((k) => k.id === childOf(i)));
  if (loose.length) groups.push({ key: "unassigned", name: "Not assigned to a child", items: loose });
  return groups;
}

/** True for the ~1.6s the bb-highlight animation runs when this row's id
 *  matches `?highlight=` in the URL — the parent arrived here from a
 *  notification's "view this" link rather than by browsing, so the row
 *  scrolls fully into view (see scrollHighlightIntoView) and bounces once to
 *  say "this one" instead of leaving them to scan the whole list. One-shot:
 *  keyed on `id`, which is stable for the row's lifetime. */
function useRowHighlight(id: string): boolean {
  const [flashing, setFlashing] = useState(false);
  useEffect(() => {
    if (getParam("highlight") !== id) return;
    let t: number | undefined;
    // The flash timer starts when the row is actually found and scrolled to,
    // not from mount — otherwise a slow-loading list could run out this
    // whole animation window before the row ever exists, and it'd scroll
    // into view already faded back to invisible.
    const stopScroll = scrollHighlightIntoView(`row-${id}`, () => {
      setFlashing(true);
      t = window.setTimeout(() => setFlashing(false), 1600);
    });
    return () => {
      stopScroll();
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  return flashing;
}

/** Elevate-and-hold + colour-matched glow applied on top of a row's own
 *  border/tint while it's the highlight target (see the bb-highlight
 *  keyframes in styles/index.css — Tailwind alone can't express it). */
const HIGHLIGHT_RING = "bb-highlight";

/** One make-up token, shared by the flat and the split-by-child lists. */
function TokenRow({ t }: { t: TokenItem }) {
  const highlighted = useRowHighlight(t.id);
  return (
    <div id={`row-${t.id}`} className={`flex flex-col gap-3 rounded-[12px] border border-[#EBE3E5] bg-white p-4 shadow-card transition-shadow sm:flex-row sm:items-center sm:gap-4 ${highlighted ? HIGHLIGHT_RING : ""}`}>
      <div className="flex min-w-0 flex-1 items-center gap-4">
        <span className="grid h-12 w-12 flex-shrink-0 place-items-center rounded-full bg-[#FEF2D7] text-[#FFD77A]"><Icon name="gift" className="h-6 w-6" /></span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-black">{t.activityTitle ?? t.provider}</h3>
          {t.activityTitle && <p className="truncate text-sm font-bold text-[#3f4b78]">{t.provider}</p>}
          <p className="text-sm font-semibold text-[#59658d]">
            Issued {sgDay(t.created_at)}
            {t.expires_at ? ` · expires ${sgDay(t.expires_at)}` : ""}
          </p>
        </div>
      </div>
      {/* On mobile these drop below the text and line up under it (past the
          48px icon + gap); on sm+ they sit inline on the right as before. */}
      <div className="flex flex-shrink-0 items-center gap-3 pl-16 sm:pl-0">
        {t.status === "issued" && t.originSlug && (
          <Button href={`/book?slug=${t.originSlug}&token=${t.id}`} size="sm" variant="outline">Redeem</Button>
        )}
        <span className={`rounded-full px-3 py-1 text-xs font-bold capitalize ${tokenStatusStyle(t.status)}`}>{t.status}</span>
      </div>
    </div>
  );
}

function tokenStatusStyle(status: string) {
  if (status === "issued") return "bg-[#F1FBEF] text-palette-green";
  if (status === "redeemed") return "bg-[#FEEBF2] text-baby-cta";
  return "bg-[#FEF9EB] text-[#FFD77A]"; // expired
}

/** One class pack, shared by the active and the used/expired lists. */
function PackageCard({ p }: { p: PackageItem }) {
  const highlighted = useRowHighlight(p.id);
  const clickable = p.status !== "expired" && p.remaining > 0;
  const Card = clickable ? "a" : "div";
  return (
    <Card
      id={`row-${p.id}`}
      {...(clickable ? { href: p.bookHref, title: "Book a class with this pack" } : {})}
      className={`flex items-center gap-4 rounded-[12px] border border-[#EBE3E5] bg-white p-4 shadow-card transition-shadow ${clickable ? "transition hover:border-baby-pink" : "opacity-60"} ${highlighted ? HIGHLIGHT_RING : ""}`}
    >
      <span className="grid h-12 w-12 flex-shrink-0 place-items-center rounded-full bg-[#FED7E4] text-baby-cta"><Icon name="store" className="h-6 w-6" /></span>
      <div className="min-w-0 flex-1">
        <h3 className="truncate font-black">{p.name}</h3>
        <p className="text-sm font-semibold text-[#59658d]">{p.provider}</p>
        {p.expiresAt && (
          <p className={`text-xs font-bold ${p.status === "expired" ? "text-[#FFC1D6]" : "text-[#6D748A]"}`}>
            {p.status === "expired" ? "Expired" : "Expires"} {sgDay(p.expiresAt)}
          </p>
        )}
      </div>
      <div className="text-right">
        {p.status === "expired" ? (
          <span className="rounded-full bg-[#FEF9EB] px-3 py-1 text-xs font-bold text-[#FFD77A]">Expired</span>
        ) : p.remaining === 0 ? (
          <span className="rounded-full bg-[#FEEBF2] px-3 py-1 text-xs font-bold text-baby-cta">All used</span>
        ) : (
          <>
            <p className="text-lg font-black text-baby-pink">{p.remaining}<span className="text-sm text-[#6D748A]">/{p.total}</span></p>
            <p className="text-xs font-bold text-[#6D748A]">credits left</p>
          </>
        )}
      </div>
    </Card>
  );
}

/** QA: "Old and active packages are all bundled together — can we split out
 *  packages and make up tokens that have expired/been used from those that are
 *  active". Used as the heading above each half of both lists. */
function PastHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-3 mt-8 border-b border-[#F4EFF0] pb-2 text-[15px] font-black uppercase tracking-wide text-[#6D748A]">
      {children}
    </h2>
  );
}

/** A pack is finished once it has expired or every credit has been spent. */
const packIsActive = (p: PackageItem) => p.status !== "expired" && p.remaining > 0;
/** Only an 'issued' token can still be redeemed; redeemed/expired are done. */
const tokenIsActive = (t: TokenItem) => t.status === "issued";

/** "Saved for" row under a favourite — assign it to one child, several, or
 *  leave it unassigned, which means the whole family. Only rendered when there
 *  is more than one child, since with one child the distinction is meaningless. */
function FavChildAssign({
  kids,
  assigned,
  onToggle,
}: {
  kids: Child[];
  assigned: string[];
  onToggle: (childId: string) => void;
}) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <span className="text-xs font-bold text-[#6D748A]">Saved for</span>
      {kids.map((k) => {
        const on = assigned.includes(k.id);
        return (
          <button
            key={k.id}
            type="button"
            onClick={() => onToggle(k.id)}
            aria-pressed={on}
            className={`rounded-full px-2.5 py-1 text-xs font-bold transition ${
              on
                // Solid CTA pink with white text — bright and on-brand, and
                // fully legible (unlike #FA4D8D text on the old #FFC1D6 chip,
                // which measured ~2.1:1).
                ? "bg-[#FA4D8D] text-white"
                : "border border-[#EBE3E5] bg-white text-[#6D748A] hover:border-baby-pink"
            }`}
          >
            {k.name}
          </button>
        );
      })}
      {assigned.length === 0 && (
        <span className="text-xs font-semibold text-[#6D748A]">· everyone</span>
      )}
    </div>
  );
}

function bookingStatusStyle(status: string) {
  if (status === "confirmed" || status === "completed") return "bg-[#F1FBEF] text-palette-green";
  if (status === "cancelled") return "bg-[#FEEBF2] text-baby-cta";
  if (status === "waitlisted") return "bg-amber-50 text-palette-yellow";
  return "bg-[#FEEBF2] text-baby-cta";
}

/** The status pill for a booking card. A multi-child party can straddle the
 *  session's capacity, so when its seats aren't all the same status it shows a
 *  two-tone summary ("2 confirmed · 1 waitlisted", green / bright orange). A
 *  solo booking, or a party whose seats all agree, keeps the single
 *  capitalised pill exactly as before. */
function BookingStatusChip({ b, className = "" }: { b: BookingItem; className?: string }) {
  const live = b.seatStatuses.filter((s) => s !== "cancelled");
  const waiting = live.filter((s) => s === "waitlisted").length;
  const confirmed = live.length - waiting;
  const mixed = b.places.length > 1 && waiting > 0 && confirmed > 0;
  const pill = "rounded-full px-3 py-1 text-xs font-bold";

  return (
    <div className={className}>
      {mixed ? (
        <span className={`inline-flex items-center gap-1.5 ${pill} bg-[#F1FBEF]`}>
          <span className="text-palette-green">{confirmed} confirmed</span>
          <span className="text-palette-green">·</span>
          <span className="text-palette-orangeStrong">{waiting} waitlisted</span>
        </span>
      ) : (
        <span className={`inline-flex capitalize ${pill} ${bookingStatusStyle(b.status)}`}>{b.status}</span>
      )}
    </div>
  );
}

type ChildRecs = ReturnType<typeof useRecommendations>["data"];

/** Add / edit a child directly against the `children` table (RLS-scoped to the
 *  signed-in parent). Used from the profile so parents can manage kids after
 *  onboarding, without going back through the signup flow. */
function ChildForm({
  parentId,
  initial,
  onSaved,
  onCancel,
}: {
  parentId: string;
  initial?: Child;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [cats, setCats] = useState<{ slug: string; name: string }[]>([]);
  const [name, setName] = useState(initial?.name ?? "");
  const [dob, setDob] = useState(initial?.date_of_birth ?? "");
  const [gender, setGender] = useState<string>(initial?.gender ?? "unspecified");
  const [interests, setInterests] = useState<string[]>(initial?.interests ?? []);
  const [avatarSeed, setAvatarSeed] = useState<string | null>(initial?.avatar_seed ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase.from("activity_categories").select("slug, name").order("sort_order").then(({ data }) => setCats(data ?? []));
  }, []);

  const input = "h-11 w-full rounded-[10px] border border-[#FED7E4] px-3 text-sm font-semibold";
  const toggle = (v: string) => setInterests((xs) => (xs.includes(v) ? xs.filter((x) => x !== v) : [...xs, v]));

  async function save() {
    if (!name.trim()) {
      setError("Please add a name.");
      return;
    }
    const dobProblem = dobError(dob);
    if (dobProblem) {
      setError(dobProblem);
      return;
    }
    setBusy(true);
    setError(null);
    // `notes` was removed from the form per QA; existing values are left untouched.
    const payload = { name: name.trim(), date_of_birth: dob, gender: gender as Gender, interests, avatar_seed: avatarSeed };
    const { error: err } = initial
      ? await supabase.from("children").update(payload).eq("id", initial.id)
      : await supabase.from("children").insert({ parent_id: parentId, ...payload });
    if (err) {
      setBusy(false);
      setError(err.message);
      return;
    }
    // Interests live on the child, but parent-level recommendations read
    // `user_preferences.interests` — keep it as the union across the children
    // so editing a child actually changes what gets suggested.
    const { data: all } = await supabase.from("children").select("interests").eq("parent_id", parentId);
    await supabase
      .from("user_preferences")
      .update({ interests: [...new Set((all ?? []).flatMap((c) => c.interests ?? []))] })
      .eq("user_id", parentId);
    setBusy(false);
    onSaved();
  }

  return (
    <div className="mt-4 rounded-[14px] border border-[#FED7E4] bg-white p-5 shadow-card">
      <h3 className="text-lg font-black">{initial ? `Edit ${initial.name}` : "Add a child"}</h3>
      {error && <p className="mt-2 rounded-[10px] bg-[#FEEBF2] px-3 py-2 text-sm font-bold text-baby-cta">{error}</p>}
      <div className="mt-3 space-y-3">
        <div>
          <p className="text-sm font-black">Avatar</p>
          <AvatarPicker
            options={CHILD_AVATARS}
            value={avatarSeed}
            onChange={setAvatarSeed}
            kind="child"
            fallbackSeed={name}
            gender={gender}
          />
        </div>
        <div><label className="mb-1 block text-sm font-black">Child's name</label><input className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Emma" /></div>
        <div>
          <label className="mb-1 block text-sm font-black">Date of birth</label>
          <DateInput value={dob} onChange={setDob} className={input} />
          <p className="mt-1 text-xs font-semibold text-[#6D748D]">Day first, e.g. 14/03/2024.</p>
        </div>
        <div className="grid grid-cols-3 gap-3">
          {[["male", "Boy"], ["female", "Girl"], ["unspecified", "Prefer not to say"]].map(([v, l]) => (
            <Chip key={v} on={gender === v} onClick={() => setGender(v)}>{l}</Chip>
          ))}
        </div>
        <div>
          <p className="mb-1 text-sm font-black">Interests</p>
          <div className="flex flex-wrap gap-2">
            {cats.map((c) => <Chip key={c.slug} on={interests.includes(c.slug)} onClick={() => toggle(c.slug)}>{c.name}</Chip>)}
          </div>
        </div>
      </div>
      <div className="mt-4 flex gap-3">
        <Button type="button" onClick={save} disabled={busy}>{busy ? "Saving…" : initial ? "Save changes" : "Add child"}</Button>
        <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

function ChildClassRow({ b }: { b: BookingItem }) {
  return (
    <a href={b.removed ? "/explore" : b.slug ? `/activity?slug=${b.slug}` : "/profile?tab=bookings"} className="flex items-center gap-3 rounded-[12px] border border-[#F4EFF0] bg-white p-3 shadow-card transition hover:border-baby-pink">
      <img src={b.image} onError={fallbackToPlaceholder} alt="" width={56} height={56} loading="lazy" decoding="async" className="h-14 w-14 rounded-[10px] object-cover" />
      <div className="min-w-0 flex-1">
        <h4 className="truncate font-black">{b.title}</h4>
        <p className="text-xs font-semibold text-[#59658d]">{b.when || "Schedule TBC"}</p>
      </div>
      <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold capitalize ${bookingStatusStyle(b.status)}`}>{b.status}</span>
    </a>
  );
}

/** The per-child panel shown when a parent taps a child: their booked classes
 *  (split upcoming vs. past) plus matched suggestions for that child. */
function ChildClasses({ child, bookings, recs }: { child: Child; bookings: BookingItem[]; recs: ChildRecs[number]["recs"] }) {
  const now = Date.now();
  // A course/camp runs over several days — it's still "upcoming" (or at
  // least not yet over) until its own end date, not just its start date; a
  // 3-day camp that began yesterday shouldn't disappear from here today.
  const isUpcoming = (b: BookingItem) => {
    const cutoff = b.isCourse && b.endsAt ? b.endsAt : b.startsAt;
    return !!cutoff && new Date(cutoff).getTime() >= now && b.status !== "cancelled";
  };
  const upcoming = bookings.filter(isUpcoming);
  const past = bookings.filter((b) => !isUpcoming(b));
  const suggestions = recs.filter((r) => r.activity);

  return (
    <section className="mt-5 rounded-[16px] border border-[#FED7E4] bg-[#FFF5F8] p-5">
      <h2 className="text-xl font-black">{child.name}'s classes</h2>
      {bookings.length === 0 ? (
        <p className="mt-3 rounded-[12px] bg-white p-4 text-sm font-semibold text-[#68718f]">
          No classes booked for {child.name} yet. <a href="/explore" className="font-black text-baby-pink">Explore activities →</a>
        </p>
      ) : (
        <div className="mt-3 space-y-4">
          {upcoming.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-black text-[#46527d]">Upcoming</h3>
              <div className="space-y-2">{upcoming.map((b) => <ChildClassRow key={b.id} b={b} />)}</div>
            </div>
          )}
          {past.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-black text-[#46527d]">Past &amp; cancelled</h3>
              <div className="space-y-2">{past.map((b) => <ChildClassRow key={b.id} b={b} />)}</div>
            </div>
          )}
        </div>
      )}
      {suggestions.length > 0 && (
        <div className="mt-5">
          <h3 className="mb-2 text-sm font-black text-[#46527d]">Suggested for {child.name}</h3>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {suggestions.slice(0, 3).map((r) => <ActivityCard key={r.id} activity={toCard(r.activity as Parameters<typeof toCard>[0])} />)}
          </div>
        </div>
      )}
    </section>
  );
}

/** "My Children" tab: list + add/edit/remove, and tap a child to see their classes. */
function ChildrenTab({
  parentId,
  kids,
  refresh,
  bookings,
  recsByChild,
}: {
  parentId: string;
  kids: Child[];
  refresh: () => Promise<void>;
  bookings: BookingItem[];
  recsByChild: ChildRecs;
}) {
  const [form, setForm] = useState<null | { child?: Child }>(null);
  const [viewId, setViewId] = useState<string | null>(null);

  async function remove(c: Child) {
    if (!window.confirm(`Remove ${c.name}'s profile? This can't be undone.`)) return;
    await supabase.from("children").delete().eq("id", c.id);
    if (viewId === c.id) setViewId(null);
    await refresh();
  }

  const viewChild = kids.find((c) => c.id === viewId) ?? null;

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-[26px] font-black">My children</h1>
        {!form && <Button type="button" onClick={() => { setForm({}); }}><Icon name="user" className="h-4 w-4" /> Add a child</Button>}
      </div>

      {form && (
        <ChildForm
          parentId={parentId}
          initial={form.child}
          onCancel={() => setForm(null)}
          onSaved={async () => { setForm(null); await refresh(); }}
        />
      )}

      {!form && (
        <>
          {kids.length === 0 ? (
            <p className="mt-4 rounded-[12px] bg-[#FFF5F8] p-5 text-center font-semibold text-[#68718f]">
              No child profiles yet — add one to get personalised matches and track their classes.
            </p>
          ) : (
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              {kids.map((c) => {
                const booked = bookings.filter((b) => b.childId === c.id).length;
                const open = viewId === c.id;
                return (
                  <div key={c.id} className={`rounded-[14px] border bg-white p-5 shadow-card transition ${open ? "border-baby-pink ring-1 ring-baby-pink/30" : "border-[#EBE3E5] hover:border-baby-pink"}`}>
                    <button type="button" onClick={() => setViewId(open ? null : c.id)} className="flex w-full items-center gap-4 text-left">
                      <AnimalAvatar seed={c.avatar_seed ?? c.name} kind="child" gender={c.gender} className="h-16 w-16 ring-4 ring-white shadow-soft" />
                      <div>
                        <h3 className="font-black">{c.name}</h3>
                        <p className="text-sm font-semibold text-[#59658d]">{formatChildAge(c.date_of_birth)}</p>
                        <p className="mt-0.5 text-xs font-bold text-baby-pink">{open ? "Hide classes ▲" : `View classes ▾${booked ? ` · ${booked} booked` : ""}`}</p>
                      </div>
                    </button>
                    {c.interests.length > 0 && (
                      <p className="mt-3 text-sm font-semibold capitalize leading-6 text-[#4a5685]"><span className="font-black text-baby-ink">Interests:</span> {c.interests.map((i) => i.replace(/-/g, " ")).join(", ")}</p>
                    )}
                    <div className="mt-3 flex items-center gap-3">
                      <Button type="button" variant="outline" size="sm" onClick={() => setForm({ child: c })}><Icon name="pen" className="h-4 w-4" /> Edit</Button>
                      <button type="button" onClick={() => remove(c)} className="text-xs font-bold text-[#FFC1D6] hover:underline">Remove</button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {viewChild && (
            <ChildClasses
              child={viewChild}
              bookings={bookings.filter((b) => b.childId === viewChild.id)}
              recs={recsByChild.find((r) => r.child.id === viewChild.id)?.recs ?? []}
            />
          )}
        </>
      )}
    </div>
  );
}


export default function ProfilePage() {
  const { session, profile, children, loading, dataResolved, signOut, refresh } = useAuth();
  // Plan gating (sidebar pill, tab locks, per-tab Plus panels) reads from
  // usePlan, which is backed by a persisted last-known value — so a hard
  // refresh renders the real plan straight away instead of flashing the
  // free/locked view while the Stripe route catches up. `planKnown` is false
  // only on a device that has never resolved a plan; until then gated UI
  // stays neutral rather than showing "Free".
  const { isPlus, known: planKnown } = usePlan();
  // Which child the journey panel and suggestions describe. Defaults to the
  // first, but every child is listed and selectable — QA: "If I have two
  // children, only one is showing on the overview".
  const [journeyChildId, setJourneyChildId] = useState<string | null>(null);
  // One per-child selection, shared by every tab that can honour it. null =
  // "All children", which splits the lists out by child rather than merging.
  const [childFilter, setChildFilter] = useState<string | null>(null);
  const [bookingSort, setBookingSort] = useState<BookingSort>(DEFAULT_BOOKING_SORT);
  const [bookingFilterOpen, setBookingFilterOpen] = useState(false);
  const [bookingStatus, setBookingStatus] = useState("all");
  // The child the journey panel and Overview suggestions describe: whoever the
  // selector names, else whichever card was last clicked, else the first.
  const journeyChild =
    (childFilter ? children.find((c) => c.id === childFilter) : children.find((c) => c.id === journeyChildId)) ??
    children[0];
  const { stats: journey, loading: journeyLoading } = useJourney(journeyChild?.id);
  const { data: recsByChild, loading: recsLoading } = useRecommendations(children);
  const [favs, setFavs] = useState<ReturnType<typeof toCard>[]>([]);
  // First favourites fetch still in flight — show a card skeleton rather than
  // flashing the "nothing saved yet" empty state on a hard refresh.
  const [favsLoaded, setFavsLoaded] = useState(false);
  // activity_id -> child ids it's assigned to. Empty/absent = whole family.
  const [favChildren, setFavChildren] = useState<Record<string, string[]>>({});
  const [bookings, setBookings] = useState<BookingItem[]>([]);
  // Until the first fetch resolves, the Bookings / Past tabs show a skeleton
  // rather than flashing the "you haven't booked anything" empty state.
  const [bookingsLoaded, setBookingsLoaded] = useState(false);
  const [reviews, setReviews] = useState<ReviewItem[]>([]);
  const [notifications, setNotifications] = useState<NotifItem[]>([]);
  const [tokens, setTokens] = useState<TokenItem[]>([]);
  const [packages, setPackages] = useState<PackageItem[]>([]);
  const [savedProviders, setSavedProviders] = useState<{ id: string; name: string }[]>([]);
  // First-fetch flags for the list tabs, so each shows a skeleton rather than
  // its "nothing here yet" empty state before the query has answered.
  const [reviewsLoaded, setReviewsLoaded] = useState(false);
  const [notifsLoaded, setNotifsLoaded] = useState(false);
  const [packagesLoaded, setPackagesLoaded] = useState(false);
  const [tokensLoaded, setTokensLoaded] = useState(false);
  const [billingPlan, setBillingPlan] = useState<{
    plan: "free" | "plus";
    status: string | null;
    current_period_end: string | null;
    cancel_at_period_end: boolean;
    terms_accepted_at: string | null;
    terms_version: string | null;
  } | null>(null);
  // The Settings plan card's headline. The full subscription fetch (dates,
  // trial, terms) lands seconds after a refresh; until then use usePlan's
  // persisted plan instead of rendering "Free" + Upgrade for a Plus parent.
  // null = never resolved on this device, so the card holds a skeleton.
  const shownPlan = billingPlan?.plan ?? (planKnown ? (isPlus ? "plus" : "free") : null);
  const [billingBusy, setBillingBusy] = useState(false);
  const tab = getParam("tab") || "overview";
  /* Unread badge on the Messages tab (QA 04/09). Free parents can read their
     conversations now, so the badge is worth showing to them too — an unread
     message they can open is exactly what it is for. */
  const unreadMessages = useUnreadMessages(Boolean(session));
  /* Same treatment for the Notifications tab. Unlike Messages, the data's
     already sitting in `notifications` (loaded whenever `session` resolves,
     see the cacheFetch above) — no separate live-count hook needed, just a
     filter over what's already on screen. */
  const unreadNotifications = notifications.filter((n) => !n.read_at).length;

  // Marks every notification read once per visit to that tab — nothing did
  // this before (the per-row dot just sat there forever), which is also why
  // the badge above would otherwise never clear. Guarded by a ref rather than
  // depending only on `tab` so it still fires if `notifications` finishes
  // loading *after* the tab is already open (a direct link to
  // /profile?tab=notifications lands before the fetch resolves), without
  // re-firing on the state update the mark-as-read call itself causes.
  const markedNotifTab = useRef(false);
  useEffect(() => {
    if (tab !== "notifications") {
      markedNotifTab.current = false;
      return;
    }
    if (!session || !notifsLoaded || markedNotifTab.current) return;
    markedNotifTab.current = true;
    if (!notifications.some((n) => !n.read_at)) return;
    const uid = session.user.id;
    const seenAt = new Date().toISOString();
    supabase
      .from("notifications")
      .update({ read_at: seenAt })
      .eq("user_id", uid)
      .is("read_at", null)
      .then(({ error }) => {
        if (error) {
          console.error("mark notifications read failed", error);
          markedNotifTab.current = false;
          return;
        }
        setNotifications((prev) => prev.map((n) => (n.read_at ? n : { ...n, read_at: seenAt })));
        cacheInvalidate(`profile:notifications:${uid}`);
        // Header's unread dot reads a separate cache entry (lib/notifications.ts) — drop it too.
        cacheInvalidate(`profile:unreadNotifications:${uid}`);
      });
  }, [tab, session, notifsLoaded, notifications]);

  // Unlike Messages (which gets a live websocket event from Stream — see
  // useUnreadMessages), a new notification row has no push to this page at
  // all; the fetch above only runs once per session mount. Poll quietly, and
  // resync immediately when the tab/app comes back to the foreground, so the
  // nav badge and edge-handle dot pick up a notification created while this
  // was already open without needing a refresh.
  useEffect(() => {
    if (!session) return;
    const uid = session.user.id;
    const reload = () =>
      cacheFetch(`profile:notifications:${uid}`, 0, () =>
        supabase
          .from("notifications")
          .select("id, type, title, body, read_at, created_at, data")
          .order("created_at", { ascending: false })
          .limit(100)
          .then(({ data }) => data ?? [])
      ).then((data) => setNotifications(data as unknown as NotifItem[]));
    const interval = setInterval(reload, 20_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") reload();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [session]);

  // Below lg the nav is a left-hand drawer, not a stacked block. Landing on the
  // profile (the Overview tab) auto-reveals it: it slides in, holds for 4s,
  // then rolls back. On the other tabs it stays closed until the edge handle
  // (› / ‹) or a tap on the dimmed page opens it. At lg the Tailwind `lg:`
  // classes drop the fixed positioning and it's a static sidebar again.
  const [menuOpen, setMenuOpen] = useState(false);
  // Once the parent has used the menu to go to another tab, coming back to
  // Overview is a menu navigation, not a fresh visit, so no reveal.
  const leftOverview = useRef(false);
  useEffect(() => {
    // Client-side nav keeps this page mounted across tab changes, so the drawer
    // has to be told to close — a full reload used to do it for free.
    setMenuOpen(false);
    if (tab !== "overview") {
      leftOverview.current = true;
      return;
    }
    if (leftOverview.current) return;
    let rollBack: ReturnType<typeof setTimeout>;
    // Open on a short delay so the closed state paints once and the slide-in
    // animates; the 4s hold is chained off the open (not anchored to mount),
    // so a slow first render still gets the full reveal.
    const slideIn = setTimeout(() => {
      setMenuOpen(true);
      rollBack = setTimeout(() => setMenuOpen(false), 4000);
    }, 60);
    return () => {
      clearTimeout(slideIn);
      clearTimeout(rollBack);
    };
  }, [tab]);

  // The mobile drawer's edge handle can be long-pressed (hold > 2s) to enter
  // "adjust mode", then dragged up or down to wherever the parent wants it.
  // The position is clamped to stay HANDLE_EDGE px clear of the top and bottom
  // of the viewport, and remembered on the device. `null` = the default,
  // vertically centred.
  const HANDLE_EDGE = 72;
  const [handleY, setHandleY] = useState<number | null>(() => {
    try {
      const v = localStorage.getItem("bb:profile-handle-y");
      return v == null || Number.isNaN(Number(v)) ? null : Number(v);
    } catch {
      return null;
    }
  });
  const [handleAdjusting, setHandleAdjusting] = useState(false);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const adjustingRef = useRef(false);
  const draggedRef = useRef(false);
  const pressStartY = useRef(0);
  useEffect(() => () => { if (holdTimer.current) clearTimeout(holdTimer.current); }, []);

  // While adjusting, kill every touch-scroll on the page — pointer capture
  // alone doesn't stop the page behind from panning, and the listener has to
  // be non-passive (React's own touch listeners are passive) to preventDefault.
  useEffect(() => {
    if (!handleAdjusting) return;
    const block = (e: TouchEvent) => e.preventDefault();
    document.addEventListener("touchmove", block, { passive: false });
    return () => document.removeEventListener("touchmove", block);
  }, [handleAdjusting]);

  const clampHandleY = (y: number) =>
    Math.min(Math.max(y, HANDLE_EDGE), window.innerHeight - HANDLE_EDGE);

  function handlePressStart(e: ReactPointerEvent<HTMLButtonElement>) {
    draggedRef.current = false;
    pressStartY.current = e.clientY;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    holdTimer.current = setTimeout(() => {
      adjustingRef.current = true;
      setHandleAdjusting(true);
      navigator.vibrate?.(25);
    }, 1000);
  }
  function handlePressMove(e: ReactPointerEvent<HTMLButtonElement>) {
    if (!adjustingRef.current) {
      // Slid away before the hold completed — that's a scroll attempt, not a
      // long-press; abandon the pending timer.
      if (holdTimer.current && Math.abs(e.clientY - pressStartY.current) > 10) {
        clearTimeout(holdTimer.current);
        holdTimer.current = null;
      }
      return;
    }
    draggedRef.current = true;
    setHandleY(clampHandleY(e.clientY));
  }
  function handlePressEnd() {
    if (holdTimer.current) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
    if (adjustingRef.current) {
      adjustingRef.current = false;
      setHandleAdjusting(false);
      // Any adjust-mode session — even a long-press with no drag — must not
      // fall through to toggling the drawer.
      draggedRef.current = true;
      setHandleY((y) => {
        if (y != null) {
          try {
            localStorage.setItem("bb:profile-handle-y", String(Math.round(y)));
          } catch {
            /* private window — the position just won't stick */
          }
        }
        return y;
      });
    }
  }
  function handlePressClick(e: ReactMouseEvent) {
    // A press that turned into a drag must not also toggle the drawer.
    if (draggedRef.current) {
      draggedRef.current = false;
      e.preventDefault();
      return;
    }
    setMenuOpen((v) => !v);
  }

  // Goes through the /api/customer/bookings backend route (service role)
  // instead of querying `bookings` directly from the browser — a direct
  // client-side query is subject to RLS's "published activities are public"
  // policy on the nested activities/activity_sessions join, which has no
  // exception for a parent viewing their own past booking. Once a vendor
  // removes/unpublishes an activity, that join silently came back null and
  // My Bookings fell back to a bare "Class" placeholder with no date.
  //
  // Unlike every other read on this page (favourites, packages, tokens,
  // notifications), this one never went through cacheFetch — every mount
  // re-ran the full route from scratch, including its own several sequential
  // DB round trips (see the route's own comments), so returning to this tab
  // always paid that cost again even seconds later. `cached: true` (the
  // initial mount) allows a fresh-enough cached copy to resolve instantly;
  // every other caller (cancel/reschedule/claim/reconcile — anything that
  // just changed a booking) omits it, which invalidates first so it can never
  // hand back a stale list right after the very action that changed it.
  function loadBookings(opts?: { cached?: boolean }) {
    const uid = session?.user.id;
    if (!uid) return;
    const key = `profile:bookings:${uid}`;
    if (!opts?.cached) cacheInvalidate(key);
    cacheFetch(key, PROFILE_FRESH_MS, () => apiGet<{
      bookings: Array<{
        id: string;
        status: string;
        child_id: string | null;
        guest_name: string | null;
        booking_group_id: string | null;
        package_purchase_id: string | null;
        children: { name: string } | null;
        activity_sessions: {
          starts_at: string;
          ends_at: string | null;
          activity_id: string;
          // Who's taking it and where in the building, per session (00074).
          teacher_name: string | null;
          studio: string | null;
          // The venue can live on the session rather than the activity
          // (migration 00074 moved location per-session), so a class run at
          // one venue leaves activities.address null.
          provider_locations: { name: string | null; address: string | null } | null;
          activities: {
            title: string; slug: string; image_urls: string[]; address: string | null;
            allow_cancellation: boolean; allow_rescheduling: boolean;
            cancellation_cutoff_hours: number; reschedule_cutoff_hours: number;
            wix_removed_at: string | null;
            wix_missing_since: string | null;
            wix_service_type: string | null;
            wix_service_id: string | null;
          } | null;
        } | null;
        compensation: "token" | "credit" | "none" | null;
        paid_with: "token" | "credit" | "cash" | "free";
        refund_mode: "refund" | "none";
        can_claim?: boolean;
      }>;
    }>("/api/customer/bookings"))
      .then(({ bookings: rows }) => {
        // A multi-child booking (00084) arrives as one row per seat sharing a
        // booking_group_id. Collapse each group into a single card; a solo
        // booking is its own group of one. Rows come newest-first, so the
        // first row seen for a key fixes the card's position in the list.
        const groups = new Map<string, typeof rows>();
        for (const r of rows) {
          const key = r.booking_group_id ?? r.id;
          const list = groups.get(key);
          if (list) list.push(r);
          else groups.set(key, [r]);
        }
        const placeName = (r: (typeof rows)[number]) =>
          r.children?.name?.trim() || r.guest_name?.trim() || "Guest child";
        setBookings(
          [...groups.values()].map((seats) => {
            // The card represents the live seats; if every seat is cancelled
            // it's a cancelled booking. Seat order: the real child first,
            // then guests in row order.
            const bySeat = (a: (typeof seats)[number], b: (typeof seats)[number]) =>
              (a.child_id ? 0 : 1) - (b.child_id ? 0 : 1);
            const live = seats.filter((x) => x.status !== "cancelled").sort(bySeat);
            const ordered = live.length > 0 ? live : [...seats].sort(bySeat);
            const r = ordered[0];
            const s = r.activity_sessions;
            const act = s?.activities;
            // A Wix COURSE booking's session row spans the whole run, so it
            // reads as a start–end date range rather than a single class time.
            const courseBooking = act?.wix_service_type === "COURSE";
            return {
              id: r.id,
              status: r.status,
              when: s?.starts_at
                ? courseBooking && s.ends_at
                  ? sgDayRange(s.starts_at, s.ends_at)
                  : sgDateTime(s.starts_at)
                : "",
              title: act?.title ?? "Class",
              slug: act?.slug ?? "",
              // activity-play is the only crop without a category tag baked
              // into the artwork, so it's the safe generic fallback.
              image: act?.image_urls?.[0] ?? ACTIVITY_PLACEHOLDER_URL,
              startsAt: s?.starts_at ?? null,
              endsAt: s?.ends_at ?? null,
              venue: s?.provider_locations?.address || s?.provider_locations?.name || act?.address || "",
              // QA 24/08: "they should be able to see under bookings".
              staff: staffLabel(s?.teacher_name, s?.studio),
              activityId: s?.activity_id ?? null,
              childId: r.child_id ?? null,
              packagePurchaseId: r.package_purchase_id ?? null,
              allowCancel: act?.allow_cancellation ?? true,
              allowReschedule: act?.allow_rescheduling ?? true,
              cancelCutoffH: act?.cancellation_cutoff_hours ?? 24,
              resCutoffH: act?.reschedule_cutoff_hours ?? 24,
              removed: act?.wix_removed_at != null || act?.wix_missing_since != null,
              compensation: r.compensation ?? null,
              paidWith: r.paid_with ?? "free",
              refundMode: r.refund_mode ?? "refund",
              // Seats of this (possibly multi-child) booking that now have a
              // spot free to pay for.
              canClaim: ordered.some((x) => x.can_claim === true),
              claimIds: ordered.filter((x) => x.can_claim === true).map((x) => x.id),
              isEvent: act?.wix_service_type === "EVENT",
              isCourse: courseBooking,
              isWixLinked: act?.wix_service_id != null,
              isWixClass: act?.wix_service_id != null && act?.wix_service_type === "CLASS",
              groupId: r.booking_group_id ?? null,
              places: ordered.map((x) => ({
                bookingId: x.id,
                name: placeName(x),
                isGuest: !x.child_id,
                status: x.status,
              })),
              allIds: ordered.map((x) => x.id),
              seatStatuses: ordered.map((x) => x.status),
            };
          })
        );
      })
      .catch(() => {})
      .finally(() => setBookingsLoaded(true));
  }

  async function loadPackages() {
    // `packages` lost its single `activity_id` column in migration 00068 (it's
    // an `activity_ids` array now), so the old `packages(activities(slug))`
    // embed no longer resolves — PostgREST 400s the whole select and the tab
    // was stuck on "No packages yet" even with credits sitting on the account.
    if (!session?.user?.id) { setPackagesLoaded(true); return; }
    const uid = session.user.id;
    let data;
    try {
      data = await cacheFetch(`profile:packages:${uid}`, PROFILE_FRESH_MS, async () => {
        const { data, error } = await supabase
          .from("package_purchases")
          .select(
            "id, credits_total, credits_remaining, status, expires_at, packages(name, activity_ids), providers(business_name)"
          )
          // RLS also lets a provider's own staff read every purchase for
          // that provider (for the vendor portal) — without this filter, a
          // parent who's *also* a vendor member sees other customers' packs
          // here as if they were their own, then hits "not enough credits"
          // at redemption because ownership is (rightly) enforced there.
          .eq("user_id", uid)
          .order("created_at", { ascending: false })
          .limit(100);
        if (error) throw error;
        return data ?? [];
      });
    } catch (error) {
      console.warn("[packages] load failed:", error instanceof Error ? error.message : error);
      setPackagesLoaded(true);
      return;
    }
    const rows = data as unknown as Array<{
      id: string;
      credits_total: number;
      credits_remaining: number;
      status: string;
      expires_at: string | null;
      packages: { name: string; activity_ids: string[] | null } | null;
      providers: { business_name: string } | null;
    }>;

    // A pack tied to exactly one class can deep-link straight to its booking
    // page — resolve those slugs in one query. Multi-class and open packs go
    // to Explore pre-searched for the provider, since there's no single class
    // to jump into.
    const soloActivityIds = [
      ...new Set(
        rows
          .map((r) => (r.packages?.activity_ids?.length === 1 ? r.packages.activity_ids[0] : null))
          .filter((id): id is string => id != null)
      ),
    ];
    const slugById = new Map<string, string>();
    if (soloActivityIds.length) {
      const { data: acts } = await supabase.from("activities").select("id, slug").in("id", soloActivityIds);
      for (const a of (acts ?? []) as Array<{ id: string; slug: string }>) slugById.set(a.id, a.slug);
    }

    setPackages(
      rows.map((r) => {
        const ids = r.packages?.activity_ids ?? [];
        const slug = ids.length === 1 ? slugById.get(ids[0]) : undefined;
        const bookHref = slug
          ? `/book?slug=${encodeURIComponent(slug)}`
          : `/explore?q=${encodeURIComponent(r.providers?.business_name ?? "")}`;
        return {
          id: r.id,
          name: r.packages?.name ?? "Class package",
          provider: r.providers?.business_name ?? "A provider",
          total: r.credits_total,
          remaining: r.credits_remaining,
          status: r.expires_at && new Date(r.expires_at) < new Date() ? "expired" : r.status,
          expiresAt: r.expires_at,
          bookHref,
        };
      })
    );
    setPackagesLoaded(true);
  }

  async function manageBilling() {
    setBillingBusy(true);
    try {
      const { url } = await apiPost<{ url?: string }>("/api/customer/stripe/portal", {});
      if (url) window.location.href = url;
    } catch {
      /* portal unavailable — button stays put */
    } finally {
      setBillingBusy(false);
    }
  }

  useEffect(() => {
    if (!session) {
      setFavsLoaded(true);
      setReviewsLoaded(true);
      setNotifsLoaded(true);
      setPackagesLoaded(true);
      setTokensLoaded(true);
      return;
    }
    const uid = session.user.id;

    cacheFetch(`profile:favs:${uid}`, PROFILE_FRESH_MS, () =>
      supabase
        .from("favorites")
        /* Upcoming sessions ride along so the card can show the next class
           rather than "Schedule TBC" (QA 24/08). Filtered to the future on the
           server — a Wix-linked class can carry hundreds of past slots, and a
           parent with twenty favourites would otherwise pull thousands of rows
           to render twenty dates. */
        .select(
          "activities(*, activity_categories!activities_category_id_fkey(name), category_2:activity_categories!activities_secondary_category_id_fkey(name), providers(business_name, address, logo_url, cover_image_url, gallery_urls), activity_sessions(starts_at, ends_at, wix_slot_key))"
        )
        .gte("activities.activity_sessions.ends_at", new Date().toISOString())
        .limit(100)
        .then(({ data }) => data ?? [])
    ).then((data) => {
      setFavs(
        data
          .map((f) => {
            const a = f.activities as unknown as
              | (Parameters<typeof toCard>[0] & { activity_categories?: { name: string }; category_2?: { name: string } })
              | null;
            return a ? toCard({ ...a, category_name: a.activity_categories?.name, category_name_2: a.category_2?.name }) : null;
          })
          .filter((x): x is ReturnType<typeof toCard> => Boolean(x))
      );
      setFavsLoaded(true);
    });

    // Which children each favourite is assigned to. A favourite with no rows is
    // saved for the whole family, which is what every pre-existing favourite is.
    cacheFetch(`profile:favChildren:${uid}`, PROFILE_FRESH_MS, () =>
      supabase
        .from("favorite_children")
        .select("activity_id, child_id")
        .limit(200)
        .then(({ data }) => (data ?? []) as { activity_id: string; child_id: string }[])
    ).then((rows) => {
      const m: Record<string, string[]> = {};
      for (const r of rows) (m[r.activity_id] ??= []).push(r.child_id);
      setFavChildren(m);
    });

    loadBookings({ cached: true });

    cacheFetch(`profile:reviews:${uid}`, PROFILE_FRESH_MS, () =>
      supabase
        .from("reviews")
        .select("id, rating, comment, provider_response, activities(title, slug)")
        .order("created_at", { ascending: false })
        .limit(100)
        .then(({ data }) => data ?? [])
    ).then((data) => {
      const rows = data as unknown as Array<{
        id: string;
        rating: number;
        comment: string | null;
        provider_response: string | null;
        activities: { title: string; slug: string } | null;
      }>;
      setReviews(
        rows.map((r) => ({
          id: r.id,
          rating: r.rating,
          comment: r.comment,
          title: r.activities?.title ?? "Activity",
          slug: r.activities?.slug ?? "",
          providerResponse: r.provider_response,
        }))
      );
      setReviewsLoaded(true);
    });

    cacheFetch(`profile:notifications:${uid}`, PROFILE_FRESH_MS, () =>
      supabase
        .from("notifications")
        .select("id, type, title, body, read_at, created_at, data")
        .order("created_at", { ascending: false })
        .limit(100)
        .then(({ data }) => data ?? [])
    ).then((data) => {
      setNotifications(data as unknown as NotifItem[]);
      setNotifsLoaded(true);
    });

    loadPackages();

    cacheFetch(`profile:favProviders:${uid}`, PROFILE_FRESH_MS, () =>
      supabase
        .from("favorite_providers")
        .select("provider_id, providers(business_name)")
        .limit(100)
        .then(({ data }) => data ?? [])
    ).then((data) => {
      const rows = data as unknown as Array<{ provider_id: string; providers: { business_name: string } | null }>;
      setSavedProviders(rows.map((r) => ({ id: r.provider_id, name: r.providers?.business_name ?? "Provider" })));
    });

    (async () => {
      const data = await cacheFetch(`profile:tokens:${uid}`, PROFILE_FRESH_MS, () =>
        supabase
          .from("make_up_tokens")
          .select("id, status, created_at, expires_at, origin_booking_id, child_id, providers(business_name)")
          .order("created_at", { ascending: false })
          .limit(100)
          .then(({ data }) => data ?? [])
      );
      const rows = data as unknown as Array<{
        id: string;
        status: string;
        created_at: string;
        expires_at: string | null;
        origin_booking_id: string | null;
        child_id: string | null;
        providers: { business_name: string } | null;
      }>;
      // Resolve the origin class from its booking — the slug so "Redeem" can
      // link to the booking page, the title so the card can lead with the
      // class name rather than just the provider.
      const originIds = [...new Set(rows.map((r) => r.origin_booking_id).filter((x): x is string => !!x))];
      const originByBooking = new Map<string, { slug: string | null; title: string | null }>();
      if (originIds.length) {
        // Via an RPC rather than a direct join: a session the vendor cancelled
        // is hidden from parents by RLS, and it is exactly the class a
        // make-up token issued for that cancellation came from.
        const { data: bks } = await supabase.rpc("my_booking_activities", { p_booking_ids: originIds });
        for (const b of (bks ?? []) as Array<{ booking_id: string; slug: string | null; title: string | null }>) {
          originByBooking.set(b.booking_id, { slug: b.slug ?? null, title: b.title ?? null });
        }
      }
      setTokens(
        rows.map((r) => {
          const origin = r.origin_booking_id ? originByBooking.get(r.origin_booking_id) ?? null : null;
          return {
            id: r.id,
            status: r.status,
            created_at: r.created_at,
            expires_at: r.expires_at,
            provider: r.providers?.business_name ?? "A provider",
            activityTitle: origin?.title ?? null,
            childId: r.child_id,
            originSlug: origin?.slug ?? null,
          };
        })
      );
      setTokensLoaded(true);
    })();

    const fetchPlan = () => {
      apiGet<{
        plan: "free" | "plus";
        status: string | null;
        current_period_end: string | null;
        cancel_at_period_end: boolean;
        terms_accepted_at: string | null;
        terms_version: string | null;
      }>("/api/customer/stripe/subscription")
        .then((p) => {
          setBillingPlan(p);
          // Keep usePlan's persisted value in step with this fuller fetch.
          primePlan(session?.user?.id, p.plan);
        })
        .catch(() => {});
    };

    // Coming back from Stripe Checkout: apply the result straight away rather
    // than waiting on the webhook, which QA found could leave a paid-for
    // upgrade reading "Free" and a bought class pack missing from Packages.
    const checkoutSession = getParam("session_id");
    if (checkoutSession) {
      apiPost("/api/stripe/reconcile", { session_id: checkoutSession })
        .catch(() => {})
        .finally(() => {
          invalidatePlan();
          fetchPlan();
          // The Stripe purchase this session just reconciled can be a new
          // package — cacheFetch's 60s TTL would otherwise hand loadPackages
          // its stale pre-purchase list.
          cacheInvalidate(`profile:packages:${uid}`);
          loadPackages();
          loadBookings();
        });
    } else {
      fetchPlan();
    }
  }, [session]);

  if (!loading && !session) return <RedirectToLanding />;

  const recs =
    recsByChild.find((r) => r.child.id === journeyChild?.id)?.recs ?? recsByChild[0]?.recs ?? [];
  const parentName = profile?.full_name || "Your family";
  // A class is "past" once its start time has gone by — except a
  // course/camp, which runs over several days and stays relevant (and
  // visible here, not buried under Past) until its own end date. Attendance
  // decides which of the two past lists a booking lands in.
  const now = Date.now();
  const isPast = (b: BookingItem) => {
    if (b.status === "cancelled") return false;
    const cutoff = b.isCourse && b.endsAt ? b.endsAt : b.startsAt;
    return !!cutoff && new Date(cutoff).getTime() < now;
  };
  const childFiltered = childFilter
    ? bookings.filter((b) => b.childId === childFilter)
    : bookings;
  const upcomingBookings = childFiltered.filter((b) => !isPast(b));
  const pastBookings = childFiltered.filter(isPast);
  // Bookings tab: status filter, then date sort. A booking with no start time
  // sorts last either way; the sort is stable so same-time bookings keep order.
  const bookingStatusCounts: Record<string, number> = {};
  for (const b of upcomingBookings) bookingStatusCounts[b.status] = (bookingStatusCounts[b.status] ?? 0) + 1;
  const shownUpcoming = upcomingBookings
    .filter((b) => bookingStatus === "all" || b.status === bookingStatus || b.places.some((p) => p.status === bookingStatus))
    .sort((a, b) => {
      if (!a.startsAt || !b.startsAt) return a.startsAt ? -1 : b.startsAt ? 1 : 0;
      const d = new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime();
      return bookingSort === "soonest" ? d : -d;
    });
  const bookingsNarrowed = bookingStatus !== "all";
  // "All children" with more than one child means split out, not merged.
  const splitByChild = childFilter === null && children.length > 1;
  // Overview: picking a child narrows the tab to them; "All children" keeps
  // one card each, which is already split out.
  const overviewChildren = childFilter ? children.filter((c) => c.id === childFilter) : children;
  const filterChild = children.find((c) => c.id === childFilter) ?? null;
  // Packs aren't bought for a particular child — any of them can spend a
  // credit — so a pack belongs to a child once one of their bookings has used
  // it, and an unspent pack belongs to all of them.
  const packChildIds = (purchaseId: string) =>
    new Set(bookings.filter((b) => b.packagePurchaseId === purchaseId && b.childId).map((b) => b.childId as string));
  const packagesForChild = (childId: string | null) =>
    childId === null
      ? packages
      : packages.filter((p) => {
          const used = packChildIds(p.id);
          return used.size === 0 || used.has(childId);
        });
  const visiblePackages = packagesForChild(childFilter);
  const visibleTokens = childFilter ? tokens.filter((t) => t.childId === childFilter) : tokens;

  // QA: packs and tokens that are spent or expired were mixed in with the live
  // ones, so what a parent could still use wasn't obvious. Split, live first.
  const activePackages = visiblePackages.filter(packIsActive);
  const finishedPackages = visiblePackages.filter((p) => !packIsActive(p));
  const activeTokens = visibleTokens.filter(tokenIsActive);
  const finishedTokens = visibleTokens.filter((t) => !tokenIsActive(t));

  // A favourite shows for a child when it's assigned to them, or to nobody in
  // particular (saved for the whole family).
  const visibleFavs = childFilter
    ? favs.filter((a) => {
        const assigned = favChildren[a.id] ?? [];
        return assigned.length === 0 || assigned.includes(childFilter);
      })
    : favs;

  /** Assign / unassign a favourite to a child, writing straight through. */
  async function toggleFavChild(activityId: string, childId: string) {
    if (!session) return;
    const assigned = favChildren[activityId] ?? [];
    const on = assigned.includes(childId);
    // Optimistic — the row is the parent's own, and a failure just reloads.
    setFavChildren((prev) => ({
      ...prev,
      [activityId]: on ? assigned.filter((c) => c !== childId) : [...assigned, childId],
    }));
    const q = supabase.from("favorite_children");
    const { error } = on
      ? await q.delete().eq("activity_id", activityId).eq("child_id", childId)
      : await q.insert({ user_id: session.user.id, activity_id: activityId, child_id: childId });
    if (error) {
      setFavChildren((prev) => ({ ...prev, [activityId]: assigned }));
    } else {
      // Local state is already correct (optimistic update above) — this just
      // keeps a later remount within the cache TTL from overwriting it with
      // the pre-toggle cached list.
      cacheInvalidate(`profile:favChildren:${session.user.id}`);
    }
  }

  return (
    <PageShell active="/profile" unreadMessages={unreadMessages} unreadNotifications={unreadNotifications}>
      {/* On mobile the order is nav → tab content → referral/contact, so
          switching tabs shows the content straight away instead of burying it
          under the promo blocks. On desktop both sidebar cards stack on the
          left with the content beside them. */}
      <main className="mx-auto flex max-w-[1122px] flex-col gap-5 px-4 py-5 sm:px-6 lg:grid lg:grid-cols-[235px_1fr] lg:grid-rows-[auto_1fr] lg:items-start">
        {/* Tap-away scrim: covers the ~50% of the page the open drawer leaves
            visible, and closes the drawer when tapped. Mobile only. */}
        {menuOpen && (
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setMenuOpen(false)}
            className="fixed inset-0 z-40 bg-black/30 lg:hidden"
          />
        )}
        {/* Edge toggle: a pink arrow on the left edge — pointing right (›) to
            open, folding into pointing left (‹) once the drawer is open. No
            box, so the page keeps its full width. A dot on it flags unread
            messages or notifications. Hold > 1s to drag it up or down.
            Mobile only. */}
        <button
          type="button"
          aria-label={
            handleAdjusting
              ? "Drag up or down to reposition, release to set"
              : menuOpen
                ? "Close menu"
                : "Open menu"
          }
          onPointerDown={handlePressStart}
          onPointerMove={handlePressMove}
          onPointerUp={handlePressEnd}
          onPointerCancel={handlePressEnd}
          onClick={handlePressClick}
          onContextMenu={(e) => e.preventDefault()}
          style={{
            top: handleY == null ? "50%" : `${clampHandleY(handleY)}px`,
            transform: `translateY(-50%)${handleAdjusting ? " scale(1.15)" : ""}`,
          }}
          // touch-none is unconditional: it has to be set before the gesture
          // starts, or the browser has already claimed the touch as a scroll.
          className={`fixed z-50 grid h-14 w-11 touch-none select-none place-items-center text-[#FA4D8D] ease-out lg:hidden ${
            handleAdjusting ? "transition-transform" : "transition-[left] duration-300"
          } ${menuOpen ? "left-[calc(62%-44px)]" : "left-0"}`}
        >
          <span className="relative -ml-2 block [filter:drop-shadow(0_0_3px_#fff)_drop-shadow(0_0_1px_#fff)]">
            {menuOpen ? (
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M15 5l-7 7 7 7" />
              </svg>
            ) : (
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M9 5l7 7-7 7" />
              </svg>
            )}
            {!menuOpen && (unreadMessages > 0 || unreadNotifications > 0) && (
              <span className="absolute -right-0.5 top-0 h-2.5 w-2.5 rounded-full border-2 border-white bg-baby-cta" />
            )}
          </span>
        </button>
        <aside
          className={`fixed inset-y-0 left-0 z-40 order-1 w-[62%] overflow-y-auto transition-transform duration-300 ease-out lg:static lg:z-auto lg:w-auto lg:overflow-visible lg:transition-none lg:translate-x-0 lg:col-start-1 lg:row-start-1 ${menuOpen ? "translate-x-0" : "-translate-x-full"}`}
        >
          <div className="min-h-full rounded-[12px] border border-[#EBE3E5] bg-white p-5 shadow-card lg:min-h-0">
            <div className="flex items-center gap-3">
              <AnimalAvatar seed={profile?.avatar_seed ?? parentName} kind="parent" className="h-14 w-14" />
              <div className="min-w-0">
                <h2 className="truncate font-black">{parentName}</h2>
                {children.map((c) => (
                  <p key={c.id} className="truncate text-sm font-semibold text-[#59658d]">
                    {c.name} · {formatChildAge(c.date_of_birth)}
                  </p>
                ))}
              </div>
            </div>
            {planKnown ? (
              <a
                href={isPlus ? "/profile?tab=settings" : "/pricing"}
                className={`mt-4 flex items-center justify-between rounded-[10px] px-3 py-2 text-sm font-bold ${isPlus ? "bg-[#FED7E4] text-baby-cta" : "bg-[#FEF4EB] text-[#FFB77A]"}`}
              >
                <span className="flex items-center gap-1.5">
                  <Icon name={isPlus ? "star" : "spark"} className="h-4 w-4" />
                  {isPlus ? "Plus plan" : "Free plan"}
                </span>
                <span className="text-xs">{isPlus ? "Manage" : "Upgrade →"}</span>
              </a>
            ) : (
              <div className="mt-4 flex items-center gap-1.5 rounded-[10px] bg-[#F4EFF0] px-3 py-2 text-sm font-bold text-[#6D7486]">
                <Icon name="spark" className="h-4 w-4 animate-pulse" />
                Checking your plan…
              </div>
            )}
            <nav className="mt-4 space-y-1.5">
              {PROFILE_TABS.map(([key, item, icon, plusOnly]) => {
                const locked = planKnown && plusOnly && !isPlus;
                return (
                  <a
                    key={key}
                    href={`/profile?tab=${key}`}
                    className={`flex items-center gap-3 rounded-[10px] px-3 py-2.5 text-[15px] font-bold ${tab === key ? "bg-[#FED7E4] text-baby-cta" : locked ? "text-[#6D7486] hover:bg-[#EDF7FD]" : "text-[#5a6484] hover:bg-[#EDF7FD]"}`}
                  >
                    <Icon name={icon} className="h-[18px] w-[18px] shrink-0" strokeWidth={1.7} /> {item}
                    {/* QA 04/09: "there should be a notification on the messages
                        tab i.e. a little 1, 2, 3 bubble depending on the number
                        so they know to check." */}
                    {key === "messages" && !locked && (
                      <UnreadBadge count={unreadMessages} className="ml-auto" />
                    )}
                    {key === "notifications" && !locked && (
                      <UnreadBadge count={unreadNotifications} className="ml-auto" label="notification" />
                    )}
                    {locked && <Icon name="lock" className="ml-auto h-3.5 w-3.5 shrink-0" />}
                  </a>
                );
              })}
            </nav>
          </div>
        </aside>
        <aside className="order-3 space-y-4 lg:col-start-1 lg:row-start-2">
          {/* Invite a friend removed: the referral mechanism isn't built,
              so the $10-credit promise had nothing behind it. */}
          <div className="rounded-[12px] bg-[#EDF7FD] p-5">
            <h3 className="font-black">Need help?</h3>
            <p className="mt-2 text-sm font-semibold">Our support team is here for you.</p>
            <a href="/contact" className="mt-4 block font-black text-[#FFC1D6]">Contact support →</a>
          </div>
        </aside>
        <section className="order-2 lg:col-start-2 lg:row-span-2 lg:row-start-1">
          {tab === "overview" && (
          <>
          {/* QA: "If I have two children, only one is showing on the overview".
              Every child gets their own card; the journey panel follows the
              child whose card is selected. The selector narrows the whole tab
              to one child, or leaves every child's card showing. */}
          <ChildSelect kids={children} value={childFilter} onChange={setChildFilter} label="Overview for" />
          <div className="grid items-start gap-5 rounded-[14px] border border-[#EBE3E5] bg-white p-6 shadow-card lg:grid-cols-[1fr_235px]">
            <div>
              {children.length === 0 ? (
                <div className="flex items-center gap-5">
                  <AnimalAvatar kind="child" className="h-24 w-24 ring-4 ring-white shadow-soft" />
                  <div>
                    <h1 className="text-[30px] font-black">Your child</h1>
                    <p className="mt-1.5 text-sm font-semibold text-[#68718f]">
                      Add a child to get personalised matches. <a href="/profile?tab=children" className="font-black text-baby-pink">Add a child →</a>
                    </p>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  {overviewChildren.map((c) => {
                    const on = c.id === journeyChild?.id;
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => setJourneyChildId(c.id)}
                        aria-pressed={on}
                        className={`flex w-full items-center gap-5 rounded-[12px] border p-3 text-left transition ${
                          children.length > 1
                            ? on
                              ? "border-baby-pink bg-[#FFF5F8] ring-1 ring-baby-pink/30"
                              : "border-[#F4EFF0] hover:border-baby-pink"
                            : "border-transparent"
                        }`}
                      >
                        <AnimalAvatar seed={c.avatar_seed ?? c.name} kind="child" gender={c.gender} className="h-20 w-20 shrink-0 ring-4 ring-white shadow-soft" />
                        <div className="min-w-0">
                          <h1 className="text-[26px] font-black leading-tight">{c.name}</h1>
                          <p className="mt-1 text-base font-semibold">{formatChildAge(c.date_of_birth)}</p>
                          {c.interests.length > 0 && (
                            <p className="mt-2 text-sm font-semibold capitalize leading-6 text-[#4a5685]">
                              <Icon name="heart" className="mr-1 inline h-3.5 w-3.5 text-[#FFC1D6]" />
                              {c.interests.map((i) => i.replace(/-/g, " ")).join(", ")}
                            </p>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="mt-5 flex flex-wrap gap-3">
                <Button href="/edit-profile" variant="outline"><Icon name="pen" className="h-4 w-4" /> Edit profile</Button>
                {children.length > 0 && (
                  <Button href="/profile?tab=children" variant="outline"><Icon name="people" className="h-4 w-4" /> Manage children</Button>
                )}
              </div>
            </div>
            <div className="rounded-[10px] bg-[#FEEBF2] p-5">
              <h2 className="mb-4 text-lg font-black">{journeyChild ? `${journeyChild.name}'s journey` : "Journey"}</h2>
              {journeyLoading ? (
                <JourneyStatsSkeleton />
              ) : (
                [
                  [`${journey?.classes_attended ?? 0} activities attended`, "calendar"],
                  [`${journey?.venues_explored ?? 0} venues explored`, "pin"],
                  [`${journey?.hours_of_learning ?? 0} hours completed`, "clock"],
                ].map(([item, icon]) => (
                  <p key={item} className="mb-4 flex items-center gap-2 text-base font-black text-[#A7D8F8]"><Icon name={icon} className="h-4 w-4" /> <span className="text-baby-ink">{item}</span></p>
                ))
              )}
            </div>
          </div>

          {/* Saved activities is a Plus feature, so on Free it shows as a
              locked teaser rather than real content — QA: "Saved activities
              shouldn't be showing under overview for free subscription". Held
              back until the plan is known so a Plus parent never sees the
              locked teaser flash on a hard refresh. */}
          {planKnown && (
          <section className="mt-6">
            <SectionTitle
              emoji="🩷"
              action={
                isPlus ? (
                  <a href="/profile?tab=favorites" className="font-bold text-[#FFC1D6]">View all →</a>
                ) : (
                  <a href="/pricing" className="flex items-center gap-1 font-bold text-[#FFC1D6]">
                    <Icon name="lock" className="h-3.5 w-3.5" /> Plus feature
                  </a>
                )
              }
            >
              Saved activities
            </SectionTitle>
            {isPlus ? (
              !favsLoaded ? (
                <ActivityCardGridSkeleton count={3} className="grid gap-4 md:grid-cols-3" />
              ) : (
                <div className="grid gap-4 md:grid-cols-3">
                  {favs.slice(0, 3).map((activity) => <ActivityCard key={activity.id} activity={activity} />)}
                  {favs.length === 0 && <p className="font-semibold text-[#68718f]">Nothing saved yet — tap the heart on any activity.</p>}
                </div>
              )
            ) : (
              <div className="relative overflow-hidden rounded-[14px] border border-dashed border-[#FFC1D6] bg-[#FFF5F8]">
                <div aria-hidden="true" className="pointer-events-none grid select-none gap-4 p-4 opacity-40 blur-[3px] md:grid-cols-3">
                  {(favs.length ? favs.slice(0, 3) : PLACEHOLDER_SAVED).map((activity) => (
                    <ActivityCard key={activity.id} activity={activity} />
                  ))}
                </div>
                <div className="absolute inset-0 grid place-items-center bg-white/55 p-6 text-center">
                  <div>
                    <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-[#FED7E4] text-baby-cta">
                      <Icon name="lock" className="h-6 w-6" />
                    </span>
                    <p className="mt-3 font-black">Saving activities is a Plus feature</p>
                    <p className="mx-auto mt-1 max-w-[360px] text-sm font-semibold text-[#68718f]">
                      Keep a shortlist of the classes you like and come back to them any time.
                    </p>
                    <Button href="/pricing" size="sm" className="mt-3"><Icon name="star" className="h-4 w-4" /> Upgrade to Plus</Button>
                  </div>
                </div>
              </div>
            )}
          </section>
          )}

          <section className="mt-6">
            {/* Say whose suggestions these are — the list already follows the
                child picked above, but nothing on screen said so. */}
            <SectionTitle action={<a href="/matches" className="font-bold text-[#FFC1D6]">See all matches →</a>}>
              {journeyChild ? `Suggested for ${journeyChild.name}` : "Suggested activities"}
            </SectionTitle>
            {/* Children land after a refresh's first paint — until they do, an
                empty list is "unknown", not "profile incomplete". */}
            {recsLoading || (Boolean(session) && !dataResolved) ? (
              <ActivityCardGridSkeleton count={3} className="grid gap-4 md:grid-cols-3" />
            ) : (
              <div className="grid gap-4 md:grid-cols-3">
                {recs.slice(0, 3).map((r) => r.activity && <ActivityCard key={r.id} activity={toCard(r.activity)} />)}
                {recs.length === 0 && <p className="font-semibold text-[#68718f]">Recommendations appear once your child profile is complete.</p>}
              </div>
            )}
          </section>

          <section className="mt-6">
            <h2 className="mb-3 text-[22px] font-black">Quick access</h2>
            <div className="grid gap-3 md:grid-cols-4">
              {[
                { label: "My bookings", icon: "calendar", href: "/profile?tab=bookings", copy: "Manage your activities" },
                { label: "Favourites", icon: "heart", href: "/profile?tab=favorites", copy: "Activities you've saved" },
                { label: "Packages", icon: "store", href: "/profile?tab=packages", copy: "Use your passes" },
                { label: "Explore nearby", icon: "pin", href: "/explore", copy: "Discover activities near you" },
              ].map((t) => <CategoryTile key={t.label} icon={t.icon} label={t.label} copy={t.copy} href={t.href} />)}
            </div>
          </section>
          </>
          )}

          {tab === "children" && session && (
            <ChildrenTab
              parentId={session.user.id}
              kids={children}
              refresh={refresh}
              bookings={bookings}
              recsByChild={recsByChild}
            />
          )}

          {tab === "bookings" && (
            <div>
              <h1 className="mb-1 text-[26px] font-black">Bookings</h1>
              <p className="mb-4 text-sm font-semibold text-[#59658d]">Classes still to come. Once a class time has passed it moves to Past activities.</p>
              <div className="mb-4 flex items-center gap-2">
                <ChildSelect kids={children} value={childFilter} onChange={setChildFilter} className="min-w-0 flex-1" />
                {bookingsLoaded && upcomingBookings.length > 1 && (
                  <BookingsFilterButton
                    open={bookingFilterOpen}
                    onToggle={() => setBookingFilterOpen((v) => !v)}
                    active={bookingFilterCount(bookingSort, bookingStatus)}
                  />
                )}
              </div>
              {bookingsLoaded && upcomingBookings.length > 1 && bookingFilterOpen && (
                <BookingsFilterPanel
                  sort={bookingSort}
                  onSort={setBookingSort}
                  status={bookingStatus}
                  onStatus={setBookingStatus}
                  counts={bookingStatusCounts}
                  total={upcomingBookings.length}
                />
              )}
              {!bookingsLoaded ? (
                <BookingsSkeleton />
              ) : splitByChild ? (
                <div className="space-y-8">
                  {groupByChild(shownUpcoming, children).map((g) => (
                    <section key={g.key}>
                      <h2 className="mb-3 border-b border-[#F4EFF0] pb-2 text-[19px] font-black">{g.name}</h2>
                      <BookingList items={g.items} emptyCopy="" onChanged={loadBookings} isPlus={isPlus} />
                    </section>
                  ))}
                  {shownUpcoming.length === 0 && (
                    <BookingList items={[]} emptyCopy={bookingsNarrowed ? "No bookings match this status." : "You haven't booked any upcoming classes yet."} onChanged={loadBookings} isPlus={isPlus} />
                  )}
                </div>
              ) : (
                <BookingList items={shownUpcoming} emptyCopy={bookingsNarrowed ? "No bookings match this status." : "You haven't booked any upcoming classes yet."} onChanged={loadBookings} isPlus={isPlus} />
              )}
            </div>
          )}

          {tab === "past" && (
            <PastActivitiesTab
              items={pastBookings}
              loading={!bookingsLoaded}
              onChanged={loadBookings}
              filterChips={<ChildSelect kids={children} value={childFilter} onChange={setChildFilter} />}
              groups={splitByChild ? groupByChild(pastBookings, children) : null}
            />
          )}

          {/* The plus-gated tabs: until the plan is known, show a brief
              placeholder rather than the Plus lock (which would flash for a
              parent who is actually on Plus). */}
          {["packages", "makeup", "favorites", "messages"].includes(tab) && !planKnown && (
            <div className="grid place-items-center py-16 text-center font-semibold text-[#6D7486]">
              <Icon name="spark" className="mb-2 h-6 w-6 animate-pulse" />
              Checking your plan…
            </div>
          )}

          {tab === "packages" && planKnown && !isPlus && (
            <PlusLock
              title="Packages are a Plus feature"
              copy="With Plus, every class pack you buy through BabyBrain is stored here and you can click straight through to book. On the free plan we email your pack details to you instead."
            />
          )}
          {tab === "packages" && isPlus && (
            <div>
              <h1 className="text-[26px] font-black">Packages</h1>
              <p className="mb-4 mt-1 text-sm font-semibold text-[#59658d]">Class packs you've bought through BabyBrain — each booking with that provider can use a credit. Packs bought directly with a provider won't appear here.</p>
              <ChildSelect kids={children} value={childFilter} onChange={setChildFilter} />
              {filterChild && (
                <p className="mb-3 rounded-[10px] bg-[#F4F0FA] px-3 py-2 text-xs font-bold text-[#7A67A6]">
                  Some pack's credits can be spent on any of your children — this shows the packs {filterChild.name} has used, plus credits to be used.
                </p>
              )}
              {!packagesLoaded ? (
                <ListRowsSkeleton count={2} lines={2} />
              ) : visiblePackages.length === 0 ? (
                <EmptyPanel icon="store" copy="No packages yet. Providers offering class packs show a 'Buy pack' option on their class pages." cta="Browse activities" href="/explore" />
              ) : (
                <>
                  {activePackages.length > 0 && (
                    <div className="mt-4 space-y-3">
                      {activePackages.map((p) => <PackageCard key={p.id} p={p} />)}
                    </div>
                  )}
                  {activePackages.length === 0 && (
                    <EmptyPanel icon="store" copy="No active packs — everything below has been used up or expired." cta="Browse activities" href="/explore" />
                  )}
                  {finishedPackages.length > 0 && (
                    <>
                      <PastHeading>Used &amp; expired</PastHeading>
                      <div className="space-y-3">
                        {finishedPackages.map((p) => <PackageCard key={p.id} p={p} />)}
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          )}

          {tab === "makeup" && planKnown && !isPlus && (
            <PlusLock
              title="Make-up tokens are a Plus feature"
              copy="With Plus, make-up tokens from every provider who issues through BabyBrain are gathered here and you can click straight through to rebook. On the free plan they come to you by email."
            />
          )}
          {tab === "makeup" && isPlus && (
            <div>
              <h1 className="text-[26px] font-black">Make-up tokens</h1>
              <p className="mb-4 mt-1 text-sm font-semibold text-[#59658d]">Credits from a provider for a missed class — redeem them when you book a future session with that provider.</p>
              <ChildSelect kids={children} value={childFilter} onChange={setChildFilter} />
              {!tokensLoaded ? (
                <ListRowsSkeleton count={2} lines={2} />
              ) : visibleTokens.length === 0 ? (
                <EmptyPanel icon="gift" copy="No make-up tokens yet. If you miss a class, your provider can issue one here." />
              ) : splitByChild ? (
                /* Split by child first, then active/finished within each child,
                   so a parent still sees whose token is whose. */
                <div className="mt-4 space-y-8">
                  {groupByChild(visibleTokens, children).map((g) => {
                    const act = g.items.filter(tokenIsActive);
                    const fin = g.items.filter((t) => !tokenIsActive(t));
                    return (
                      <section key={g.key}>
                        <h2 className="mb-3 border-b border-[#F4EFF0] pb-2 text-[19px] font-black">{g.name}</h2>
                        {act.length > 0 && <div className="space-y-3">{act.map((t) => <TokenRow key={t.id} t={t} />)}</div>}
                        {fin.length > 0 && (
                          <>
                            <PastHeading>Used &amp; expired</PastHeading>
                            <div className="space-y-3">{fin.map((t) => <TokenRow key={t.id} t={t} />)}</div>
                          </>
                        )}
                      </section>
                    );
                  })}
                </div>
              ) : (
                <>
                  {activeTokens.length > 0 && (
                    <div className="mt-4 space-y-3">
                      {activeTokens.map((t) => <TokenRow key={t.id} t={t} />)}
                    </div>
                  )}
                  {activeTokens.length === 0 && (
                    <EmptyPanel icon="gift" copy="No tokens left to redeem — everything below has been used or has expired." />
                  )}
                  {finishedTokens.length > 0 && (
                    <>
                      <PastHeading>Used &amp; expired</PastHeading>
                      <div className="space-y-3">
                        {finishedTokens.map((t) => <TokenRow key={t.id} t={t} />)}
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          )}

          {tab === "favorites" && planKnown && !isPlus && (
            <PlusLock
              title="Saved favourites are a Plus feature"
              copy="Upgrade to keep your favourite activities and providers on your own list, so you can come back to them any time."
            />
          )}
          {tab === "favorites" && isPlus && (
            <div>
              <h1 className="mb-4 text-[26px] font-black">Favourites</h1>
              <ChildSelect kids={children} value={childFilter} onChange={setChildFilter} />
              {filterChild && (
                <p className="mb-3 rounded-[10px] bg-[#F4F0FA] px-3 py-2 text-xs font-bold text-[#7A67A6]">
                  Showing what's saved for {filterChild.name}, plus anything saved for the whole family.
                </p>
              )}
              {!favsLoaded ? (
                <ActivityCardGridSkeleton count={6} className="grid gap-4 md:grid-cols-3" />
              ) : favs.length === 0 ? (
                <EmptyPanel icon="heart" copy="Nothing saved yet — tap the heart on any activity." cta="Browse activities" href="/explore" />
              ) : visibleFavs.length === 0 ? (
                <EmptyPanel icon="heart" copy={`Nothing saved for ${filterChild?.name ?? "this child"} yet — use "Saved for" on any favourite to assign it.`} cta="Browse activities" href="/explore" />
              ) : (
                <div className="grid gap-4 md:grid-cols-3">
                  {visibleFavs.map((activity) => (
                    // self-start: without it, grid's default row-stretch sizes this wrapper
                    // to fit ActivityCard *and* FavChildAssign together, then ActivityCard's
                    // own h-full expands to fill that whole stretched box — pushing
                    // FavChildAssign to overflow past the wrapper, under the next row's card.
                    <div key={activity.id} className="self-start">
                      <ActivityCard
                        activity={activity}
                        onFavoriteToggled={(id, saved) => {
                          if (!saved) setFavs((prev) => prev.filter((a) => a.id !== id));
                        }}
                      />
                      {children.length > 1 && (
                        <FavChildAssign
                          kids={children}
                          assigned={favChildren[activity.id] ?? []}
                          onToggle={(childId) => toggleFavChild(activity.id, childId)}
                        />
                      )}
                    </div>
                  ))}
                </div>
              )}

              {savedProviders.length > 0 && (
                <div className="mt-8">
                  <h2 className="mb-3 text-xl font-black">Saved providers</h2>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {savedProviders.map((p) => (
                      <div key={p.id} className="flex items-center gap-3 rounded-[12px] border border-[#EBE3E5] bg-white p-4 shadow-card">
                        <span className="grid h-11 w-11 flex-shrink-0 place-items-center rounded-full bg-[#FED7E4] text-baby-cta"><Icon name="store" className="h-5 w-5" /></span>
                        <h3 className="truncate font-black">{p.name}</h3>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* QA 04/09: the copy here promised "you can still read messages on
              your booked classes for free" while the tab showed nothing but an
              upgrade card. Free parents now get the reading half — the same
              inbox, with the composer replaced by an upgrade line — above a
              short note about what Plus adds. */}
          {tab === "messages" && planKnown && !isPlus && session && (
            <div>
              <h1 className="mb-4 text-[26px] font-black">Messages</h1>
              <p className="mb-4 rounded-[12px] bg-[#EDF7FD] px-4 py-3 text-sm font-semibold text-[#59658d]">
                You can read the conversations you're part of. Replying, and starting a new
                conversation with a provider, needs{" "}
                <a href="/pricing" className="font-black text-baby-pink hover:underline">Plus</a>.
              </p>
              <Suspense fallback={<MessagesSkeleton />}>
                <MessagesTab userId={session.user.id} readOnly />
              </Suspense>
            </div>
          )}
          {tab === "messages" && isPlus && session && (
            <div>
              <h1 className="mb-4 text-[26px] font-black">Messages</h1>
              <Suspense fallback={<MessagesSkeleton />}>
                <MessagesTab userId={session.user.id} />
              </Suspense>
            </div>
          )}

          {tab === "reviews" && (
            <div>
              <h1 className="mb-4 text-[26px] font-black">Reviews</h1>
              {!reviewsLoaded ? (
                <ListRowsSkeleton count={3} lines={2} />
              ) : reviews.length === 0 ? (
                <EmptyPanel icon="star" copy="You haven't written any reviews yet." cta="Browse activities" href="/explore" />
              ) : (
                <div className="space-y-3">
                  {reviews.map((r) => (
                    <div key={r.id} className="rounded-[12px] border border-[#EBE3E5] bg-white p-4 shadow-card">
                      <div className="flex items-center justify-between">
                        <a href={r.slug ? `/activity?slug=${r.slug}` : "/explore"} className="font-black hover:text-baby-pink">{r.title}</a>
                        <span className="flex gap-0.5 text-[#FFD77A]">{Array.from({ length: r.rating }).map((_, i) => <Icon key={i} name="star" className="h-4 w-4 fill-current" />)}</span>
                      </div>
                      {r.comment && <p className="mt-1.5 font-semibold text-[#34406f]">{r.comment}</p>}
                      {r.providerResponse && (
                        <div className="mt-2 rounded-[10px] bg-[#FFF5F8] p-3">
                          <p className="text-xs font-black text-baby-pink">Response from the provider</p>
                          <p className="mt-1 text-sm font-semibold text-[#34406f]">{r.providerResponse}</p>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === "notifications" && (
            <div>
              <h1 className="mb-4 text-[26px] font-black">Notifications</h1>
              {!notifsLoaded ? (
                <ListRowsSkeleton count={4} lines={2} />
              ) : notifications.length === 0 ? (
                <EmptyPanel icon="bell" copy="No notifications yet — booking updates and reminders will show up here." />
              ) : (
                <div className="space-y-2.5">
                  {notifications.map((n) => <NotificationRow key={n.id} n={n} />)}
                </div>
              )}
            </div>
          )}

          {tab === "settings" && (
            <div>
              <h1 className="mb-4 text-[26px] font-black">Settings</h1>

              {getParam("billing") === "success" && (
                <div className="mb-4 rounded-[12px] border border-green-300 bg-green-50 px-4 py-3 text-sm font-bold text-palette-green">
                  🎉 Welcome to Plus! Your subscription is active.
                </div>
              )}

              {/* Plan & Billing */}
              <div className="mb-4 rounded-[14px] border border-[#EBE3E5] bg-white p-6 shadow-card">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-xs font-bold uppercase tracking-wide text-[#6D748A]">Plan</p>
                    {shownPlan === null ? (
                      <div aria-hidden="true" className="mt-2 h-6 w-40 animate-pulse rounded bg-[#F3EDF0]" />
                    ) : (
                      <p className="mt-1 flex flex-wrap items-center gap-2 text-lg font-black">
                        <Icon name={shownPlan === "plus" ? "star" : "heart"} className="h-5 w-5 text-baby-pink" />
                        {shownPlan === "plus" ? "BabyBrain Plus" : "Free"}
                        {billingPlan?.status === "trialing" && (
                          <span className="rounded-full bg-[#FED7E4] px-2 py-0.5 text-xs font-bold text-baby-cta">Free trial</span>
                        )}
                        {billingPlan?.cancel_at_period_end && (
                          <span className="rounded-full bg-[#FEF4EB] px-2 py-0.5 text-xs font-bold text-[#FFD77A]">Cancels at period end</span>
                        )}
                      </p>
                    )}
                    {billingPlan?.plan === "plus" && billingPlan.current_period_end && (
                      <p className="mt-1 text-sm font-semibold text-[#59658d]">
                        {billingPlan.cancel_at_period_end ? "Access until" : "Renews on"}{" "}
                        {sgDay(billingPlan.current_period_end)}
                      </p>
                    )}
                  </div>
                  {shownPlan === null ? (
                    <div aria-hidden="true" className="h-10 w-36 animate-pulse rounded-full bg-[#F3EDF0]" />
                  ) : shownPlan === "plus" ? (
                    <Button type="button" variant="outline" onClick={manageBilling} disabled={billingBusy}>
                      {billingBusy ? "Opening…" : "Manage / Cancel"}
                    </Button>
                  ) : (
                    <Button href="/pricing"><Icon name="star" className="h-4 w-4" /> Upgrade to Plus</Button>
                  )}
                </div>
                {billingPlan?.terms_accepted_at && (
                  <p className="mt-4 border-t border-[#F4EFF0] pt-3 text-xs font-semibold text-[#6D748A]">
                    <Icon name="check" className="mr-1 inline h-3.5 w-3.5 text-palette-green" />
                    Terms &amp; Conditions accepted on {sgDay(billingPlan.terms_accepted_at)}
                    {billingPlan.terms_version ? ` (v${billingPlan.terms_version})` : ""} ·{" "}
                    <a href="/terms" className="text-baby-pink underline">View terms</a>
                  </p>
                )}
              </div>

              <div className="space-y-4 rounded-[14px] border border-[#EBE3E5] bg-white p-6 shadow-card">
                <div>
                  <p className="text-xs font-bold uppercase tracking-wide text-[#6D748A]">Name</p>
                  <p className="font-black">{profile?.full_name || "—"}</p>
                </div>
                <div className="border-t border-[#F4EFF0] pt-4">
                  <p className="text-xs font-bold uppercase tracking-wide text-[#6D748A]">Email</p>
                  <p className="font-black">{session?.user.email || "—"}</p>
                </div>
                <div className="flex flex-wrap gap-3 border-t border-[#F4EFF0] pt-4">
                  <Button href="/edit-profile" variant="outline"><Icon name="pen" className="h-4 w-4" /> Edit profile</Button>
                  <Button href="/forgot-password" variant="outline"><Icon name="lock" className="h-4 w-4" /> Change password</Button>
                  <Button type="button" variant="soft" onClick={() => signOut()}>Sign out</Button>
                </div>
              </div>

              <NotificationsPanel />

              <DeleteAccountPanel isPlus={isPlus} />
            </div>
          )}
        </section>
      </main>
      <Footer />
    </PageShell>
  );
}

/** Settings → Notifications. Only rendered for an installed app (isStandalone) —
 *  iOS can't deliver push to a plain Safari tab at all, and prompting
 *  tab visitors elsewhere is friction with no payoff. Mirrors the toggle
 *  pattern of the other Settings cards above it. */
function NotificationsPanel() {
  const [state, setState] = useState<PushState | "loading">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getPushState().then(setState).catch(() => setState("unsupported"));
  }, []);

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      setState(state === "subscribed" ? await unsubscribeFromPush() : await subscribeToPush());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't update your notification setting — try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!isStandalone() || state === "unsupported") return null;

  return (
    <div className="mt-4 rounded-[14px] border border-[#EBE3E5] bg-white p-6 shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-bold uppercase tracking-wide text-[#6D748A]">Notifications</p>
          <p className="mt-1 font-black">Push notifications</p>
          <p className="mt-1 text-sm font-semibold text-[#59658d]">
            {state === "denied"
              ? "Blocked in your device settings — enable notifications for BabyBrain there to turn this back on."
              : "Get a notification for booking updates and messages, even when the app is closed."}
          </p>
        </div>
        {state !== "denied" && state !== "loading" && (
          <Button type="button" variant={state === "subscribed" ? "outline" : "primary"} onClick={toggle} disabled={busy}>
            {busy ? "Saving…" : state === "subscribed" ? "Turn off" : "Turn on"}
          </Button>
        )}
      </div>
      {error && <p className="mt-3 text-sm font-bold text-red-600">{error}</p>}
    </div>
  );
}

/** What a parent has to type to unlock the delete button — exact, so a stray
 *  tap or autofill can't confirm it. */
const DELETE_PHRASE = "DELETE ACCOUNT";

/** Settings → Delete account. The button opens a warning pop-up: the parent
 *  has to read that it's permanent (packages and make-up tokens lost, not
 *  refunded) and type DELETE ACCOUNT before "Permanently delete" switches on.
 *  The route cancels any live Plus subscription before removing the account.
 *  Tapping outside the pop-up does not dismiss it, so a stray tap can't wave
 *  the warning away; "Keep my account" and Escape do. */
function DeleteAccountPanel({ isPlus }: { isPlus: boolean }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const close = () => {
    setOpen(false);
    setConfirm("");
    setError(null);
  };

  // While the pop-up is up: focus the field, freeze the page behind it, and
  // let Escape back out (never mid-delete).
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) close();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, busy]);

  async function remove() {
    if (confirm !== DELETE_PHRASE) return;
    setBusy(true);
    setError(null);
    try {
      await apiPost("/api/customer/account", { confirm: "DELETE" });
      await supabase.auth.signOut();
      goTo("/?deleted=1", { hard: true });
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : "We couldn't delete your account — please contact hello@babybrain.sg.");
    }
  }

  const ready = confirm === DELETE_PHRASE && !busy;

  return (
    <div className="mt-4 rounded-[14px] border border-[#FED7E4] bg-white p-6 shadow-card">
      <h2 className="font-black text-[#FFC1D6]">Delete your account</h2>
      <p className="mt-1 text-sm font-semibold text-[#59658d]">
        This removes your profile, your children's details, preferences and saved activities.
        {" "}Any unused packages and make-up tokens will be lost and not refunded.
        {isPlus ? " Your Plus subscription is cancelled at the same time, so you won't be charged again." : ""}
        {" "}It can't be undone.
      </p>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-4 rounded-[11px] border border-[#FED7E4] px-5 py-2.5 text-sm font-extrabold text-[#FFC1D6] hover:bg-[#FFF5F8]"
      >
        Delete account
      </button>

      {open &&
        createPortal(
          <div className="fixed inset-0 z-[70] grid place-items-center overflow-y-auto bg-black/45 p-4">
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="delete-title"
              aria-describedby="delete-copy"
              className="w-full max-w-[420px] rounded-[18px] bg-white p-6 shadow-card"
            >
              <span className="grid h-11 w-11 place-items-center rounded-full bg-[#FEEBF2]" aria-hidden="true">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#C90044" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 9v4M12 17h.01" />
                  <path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z" />
                </svg>
              </span>
              <h2 id="delete-title" className="mt-3 text-xl font-black">Delete your account?</h2>
              <p id="delete-copy" className="mt-2 text-sm font-semibold leading-6 text-[#44507b]">
                This removes your profile, your children's details, preferences and saved activities. Any unused packages and make-up tokens will be lost and not refunded. It can't be undone.
              </p>
              {isPlus && (
                <p className="mt-3 rounded-[10px] bg-[#FFF5F8] px-3 py-2.5 text-[13px] font-semibold leading-5 text-[#59658d]">
                  Your Plus subscription is cancelled at the same time, so you won't be charged again.
                </p>
              )}
              <label htmlFor="delete-confirm" className="mt-4 block text-sm font-black text-[#34406f]">
                Type <span className="text-baby-cta">{DELETE_PHRASE}</span> to confirm
              </label>
              <input
                id="delete-confirm"
                ref={inputRef}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && ready) void remove();
                }}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                className="mt-2 block h-12 w-full rounded-[10px] border-[1.5px] border-[#F4A6C0] px-3 text-[15px] font-semibold tracking-wide focus:border-[#FA4D8D] focus:outline-none"
                placeholder={DELETE_PHRASE}
              />
              {error && <p className="mt-3 text-sm font-bold text-baby-cta">{error}</p>}
              <div className="mt-5 grid gap-2">
                <button
                  type="button"
                  disabled={!ready}
                  onClick={remove}
                  className={`h-12 rounded-[11px] text-[15px] font-extrabold text-white ${
                    ready ? "bg-[#C90044] hover:brightness-110" : "cursor-not-allowed bg-[#E0A9BB]"
                  }`}
                >
                  {busy ? "Deleting…" : "Permanently delete"}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={close}
                  className="h-12 rounded-[11px] border border-[#EBE3E5] bg-white text-[15px] font-extrabold text-[#34406f]"
                >
                  Keep my account
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}

/** Past classes, split by whether the parent (or the provider) marked them as
 *  attended. QA: "Once time has passed for a class, it was still showing in
 *  bookings… Can we call this Past activities and have an attended and not
 *  attended section?" */
function PastActivitiesTab({
  items,
  onChanged,
  filterChips,
  groups,
  loading = false,
}: {
  items: BookingItem[];
  onChanged: () => void;
  filterChips?: ReactNode;
  /** Set when "All children" is chosen and there's more than one child: the
   *  same three attendance sections, repeated under each child's name. */
  groups?: { key: string; name: string; items: BookingItem[] }[] | null;
  /** First bookings fetch still in flight — show a skeleton, not the empty state. */
  loading?: boolean;
}) {
  const [marks, setMarks] = useState<Record<string, "present" | "absent">>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (items.length === 0) return;
    supabase
      .from("attendance")
      .select("booking_id, status")
      .in("booking_id", items.map((b) => b.id))
      .then(({ data }) => {
        const next: Record<string, "present" | "absent"> = {};
        for (const row of (data ?? []) as unknown as { booking_id: string; status: string }[]) {
          if (row.status === "present" || row.status === "late") next[row.booking_id] = "present";
          else if (row.status === "absent") next[row.booking_id] = "absent";
        }
        setMarks(next);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.map((b) => b.id).join(",")]);

  async function mark(b: BookingItem, status: "present" | "absent") {
    setBusyId(b.id);
    setError(null);
    const { error: err } = await supabase.rpc("mark_own_attendance", {
      p_booking_id: b.id,
      p_status: status,
    });
    setBusyId(null);
    if (err) {
      setError(cleanRpcErrorMessage(err));
      return;
    }
    setMarks((m) => ({ ...m, [b.id]: status }));
    onChanged();
  }

  // A completed booking counts as attended even if nobody ticked it.
  const statusOf = (b: BookingItem) => marks[b.id] ?? (b.status === "completed" ? "present" : null);

  function Row({ b }: { b: BookingItem }) {
    const state = statusOf(b);
    return (
      <div className="rounded-[12px] border border-[#EBE3E5] bg-white p-3 shadow-card">
        <div className="flex items-center gap-4">
          <img src={b.image} onError={fallbackToPlaceholder} alt="" width={56} height={56} loading="lazy" decoding="async" className="h-14 w-14 flex-shrink-0 rounded-[10px] object-cover" />
          <div className="min-w-0 flex-1">
            <a href={b.slug && !b.removed ? `/activity?slug=${b.slug}` : "/explore"} className="block truncate font-black hover:text-baby-pink">{b.title}</a>
            {b.when && <p className="text-sm font-semibold text-[#59658d]">{b.when}</p>}
          </div>
          {state && (
            <span className={`shrink-0 rounded-full px-3 py-1 text-xs font-bold ${state === "present" ? "bg-[#F1FBEF] text-palette-green" : "bg-[#FEF9EB] text-[#FFD77A]"}`}>
              {state === "present" ? "Attended" : "Not attended"}
            </span>
          )}
        </div>
        <div className="mt-2 flex justify-end gap-2 border-t border-[#FAF7F7] pt-2">
          <button
            type="button"
            disabled={busyId === b.id}
            onClick={() => mark(b, "present")}
            className={`rounded-[9px] px-3 py-1.5 text-xs font-bold ${state === "present" ? "border border-green-300 bg-[#F1FBEF] text-palette-green" : "border border-[#FED7E4] text-[#FFC1D6] hover:bg-[#FFF5F8]"}`}
          >
            We went
          </button>
          <button
            type="button"
            disabled={busyId === b.id}
            onClick={() => mark(b, "absent")}
            className={`rounded-[9px] px-3 py-1.5 text-xs font-bold ${state === "absent" ? "border border-[#EBE3E5] bg-[#FAF7F7] text-[#5a6484]" : "border border-[#FED7E4] text-[#FFC1D6] hover:bg-[#FFF5F8]"}`}
          >
            We missed it
          </button>
        </div>
      </div>
    );
  }

  /** The three attendance sections for one list of classes. */
  function Sections({ list }: { list: BookingItem[] }) {
    const attended = list.filter((b) => statusOf(b) === "present");
    const notAttended = list.filter((b) => statusOf(b) === "absent");
    const unmarked = list.filter((b) => statusOf(b) === null);
    return (
      <div className="mt-4 space-y-6">
        {unmarked.length > 0 && (
          <section>
            <h2 className="mb-2 text-sm font-black text-[#46527d]">Did you make it? ({unmarked.length})</h2>
            <div className="space-y-3">{unmarked.map((b) => <Row key={b.id} b={b} />)}</div>
          </section>
        )}
        <section>
          <h2 className="mb-2 text-sm font-black text-[#46527d]">Attended ({attended.length})</h2>
          {attended.length === 0
            ? <p className="rounded-[12px] bg-[#FFF5F8] p-4 text-sm font-semibold text-[#68718f]">No attended classes recorded yet.</p>
            : <div className="space-y-3">{attended.map((b) => <Row key={b.id} b={b} />)}</div>}
        </section>
        <section>
          <h2 className="mb-2 text-sm font-black text-[#46527d]">Not attended ({notAttended.length})</h2>
          {notAttended.length === 0
            ? <p className="rounded-[12px] bg-[#FFF5F8] p-4 text-sm font-semibold text-[#68718f]">Nothing missed — nice work.</p>
            : <div className="space-y-3">{notAttended.map((b) => <Row key={b.id} b={b} />)}</div>}
        </section>
      </div>
    );
  }

  return (
    <div>
      <h1 className="mb-1 text-[26px] font-black">Past activities</h1>
      <p className="mb-4 text-sm font-semibold text-[#59658d]">Classes whose time has passed. Tell us whether you made it — your provider can mark this too.</p>
      {filterChips}
      {error && <p className="mt-3 rounded-[10px] bg-[#FEEBF2] px-3 py-2 text-sm font-bold text-baby-cta">{error}</p>}

      {loading ? (
        <BookingsSkeleton />
      ) : items.length === 0 ? (
        <EmptyPanel icon="check" copy="Nothing here yet — classes move across once their time has passed." cta="Browse activities" href="/explore" />
      ) : groups ? (
        <div className="mt-4 space-y-8">
          {groups.map((g) => (
            <section key={g.key}>
              <h2 className="mb-3 border-b border-[#F4EFF0] pb-2 text-[19px] font-black">{g.name}</h2>
              <Sections list={g.items} />
            </section>
          ))}
        </div>
      ) : (
        <Sections list={items} />
      )}
    </div>
  );
}

/** The seats of a multi-child booking (00084). The "N children" line is the
 *  disclosure toggle; opening it reveals the roster indented right beneath.
 *  Seat 1 is the chosen child (read-only); guest seats read "Guest child"
 *  until the parent renames them — the name is written to bookings.guest_name
 *  and shows on the vendor's roster too. Each seat can be cancelled on its
 *  own, leaving the rest of the party booked. */
function PartyPlaces({
  b, onRename, onCancelPlace, editable, cancelWhy,
}: {
  b: BookingItem;
  onRename: (bookingId: string, name: string) => void;
  onCancelPlace: (bookingId: string, name: string) => void;
  editable: boolean;
  cancelWhy: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const listId = `party-${b.id}`;
  const initial = (name: string) => name.trim().charAt(0).toUpperCase() || "?";

  return (
    <div className="mt-2 pl-0 sm:mt-1 sm:pl-20">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={listId}
        className="group flex items-center gap-2 text-sm font-bold text-[#59658d] transition-colors hover:text-baby-cta"
      >
        <Icon name="people" className="h-4 w-4 text-baby-lilac" />
        <span>{b.places.length} children</span>
        <span className="grid h-5 w-5 place-items-center rounded-full bg-[#F3EDF8] transition-colors group-hover:bg-[#FCE6EF]">
          <Icon
            name="chevron"
            strokeWidth={2.4}
            className={`h-3 w-3 text-[#9A86C4] transition-transform duration-200 ${open ? "-rotate-90" : "rotate-90"}`}
          />
        </span>
      </button>

      {open && (
        <ul id={listId} className="mt-2.5 space-y-1.5">
          {b.places.map((p, i) => {
            const unnamed = p.isGuest && p.name === "Guest child";
            return (
              <li key={p.bookingId} className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
                <span
                  className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-[11px] font-black ${
                    p.isGuest ? "bg-[#F1EEF6] text-[#8A7FB0]" : "bg-[#FEEBF2] text-baby-cta"
                  }`}
                >
                  {p.isGuest ? <Icon name="user" className="h-3.5 w-3.5" /> : initial(p.name)}
                </span>

                {editing === p.bookingId ? (
                  <>
                    <input
                      autoFocus
                      value={draft}
                      maxLength={80}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") { onRename(p.bookingId, draft); setEditing(null); }
                        if (e.key === "Escape") setEditing(null);
                      }}
                      placeholder="Guest child"
                      className="min-w-0 flex-1 rounded-[9px] border border-[#FED7E4] px-2.5 py-1.5 text-sm font-semibold outline-none focus:border-baby-pink"
                    />
                    <button type="button" onClick={() => { onRename(p.bookingId, draft); setEditing(null); }} className="text-xs font-black text-baby-pink">Save</button>
                    <button type="button" onClick={() => setEditing(null)} className="text-xs font-bold text-[#8A93AC]">Cancel</button>
                  </>
                ) : (
                  <>
                    <span className={`flex-1 truncate text-sm font-bold ${unnamed ? "text-[#8A93AC]" : "text-[#3f4b78]"}`}>
                      {p.name}
                    </span>
                    {/* Only the seats that landed on the waitlist are called
                        out — when the whole party is waitlisted the card's own
                        pill already says so. */}
                    {p.status === "waitlisted" && b.places.some((q) => q.status !== "waitlisted") && (
                      <span className="shrink-0 rounded-full bg-palette-orangeSoft px-2 py-0.5 text-[10px] font-black text-palette-orangeStrong">
                        Waitlisted
                      </span>
                    )}
                    {editable && p.isGuest && (
                      <button
                        type="button"
                        onClick={() => { setDraft(unnamed ? "" : p.name); setEditing(p.bookingId); }}
                        className="flex items-center gap-1 rounded-[8px] border border-[#E7DEEF] px-2 py-1 text-xs font-bold text-[#9A86C4] hover:bg-[#F7F3FB]"
                      >
                        <Icon name="pen" className="h-3 w-3" /> Name
                      </button>
                    )}
                    {editable && b.places.length > 1 && (
                      <button
                        type="button"
                        onClick={() => onCancelPlace(p.bookingId, p.name)}
                        className={`rounded-[8px] px-2 py-1 text-xs font-bold ${
                          cancelWhy
                            ? "cursor-not-allowed border border-[#EBE3E5] bg-[#FAF7F7] text-[#8A93AC]"
                            : "border border-[#FED7E4] text-[#F2739E] hover:bg-[#FFF5F8]"
                        }`}
                        title={cancelWhy ?? `Cancel ${p.name}'s place`}
                      >
                        Cancel place
                      </button>
                    )}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function BookingList({ items, emptyCopy, onChanged, isPlus = true }: { items: BookingItem[]; emptyCopy: string; onChanged?: () => void; isPlus?: boolean }) {
  // 2.2: cancel / reschedule with vendor-configured policies. Unavailable
  // actions grey out and explain themselves in a pop-up.
  const [notice, setNotice] = useState<string | null>(null);
  const [reschedFor, setReschedFor] = useState<BookingItem | null>(null);
  const [exporting, setExporting] = useState(false);
  const [reschedSessions, setReschedSessions] = useState<{ id: string; starts_at: string }[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Arrived here from a notification's "view this booking" link — scroll to
  // and briefly flash that one row (see useRowHighlight's comment; this list
  // renders its rows inline rather than through a per-row component, so the
  // same one-shot behaviour is done here with plain state instead of the
  // hook, to keep the number of hooks fixed regardless of `items.length`).
  const [highlightId] = useState<string | null>(() => getParam("highlight"));
  // Separate from highlightId itself (which never changes once set): this
  // flips true only once the target row is actually found and scrolled to,
  // and only then starts the fade-out timer — a fixed timer running from
  // mount could finish (and fade back to invisible) before a slow-loading
  // list ever rendered the row for it to highlight, which is exactly what
  // "the highlighted row is there but not visibly marked" looked like.
  const [flashing, setFlashing] = useState(false);
  useEffect(() => {
    if (!highlightId) return;
    let t: number | undefined;
    const stopScroll = scrollHighlightIntoView(`row-${highlightId}`, () => {
      setFlashing(true);
      t = window.setTimeout(() => setFlashing(false), 1600);
    });
    return () => {
      stopScroll();
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightId]);

  const hoursLabel = (h: number) => (h === 1 ? "1 hour" : `${h} hours`);
  const upcoming = (b: BookingItem) =>
    b.startsAt != null && new Date(b.startsAt) > new Date() && ["pending", "confirmed", "waitlisted"].includes(b.status);
  const cutoffPassed = (b: BookingItem, hours: number) =>
    b.startsAt != null && new Date(b.startsAt).getTime() - hours * 36e5 < Date.now();

  const cancelBlockReason = (b: BookingItem) =>
    b.isEvent
      ? "This is a ticketed event — it can't be cancelled once booked. Contact the provider if you need help."
      : b.isCourse
      ? "This is a course — your enrolment covers the whole run, so it can't be cancelled online. Contact the provider if you need help."
      : !b.allowCancel
      ? "The provider does not allow cancellations for this class. Contact them directly if you need help."
      : cutoffPassed(b, b.cancelCutoffH)
        ? `The cancellation window for this class has closed — cancellations close ${hoursLabel(b.cancelCutoffH)} before the session.`
        : null;
  const reschedBlockReason = (b: BookingItem) =>
    b.isEvent
      ? "This is a ticketed event — it can't be rescheduled once booked. Contact the provider if you need help."
      : b.isCourse
      ? "This is a course — your enrolment covers every session in the run, so there's no single class to move. Contact the provider if you need help."
      : !b.allowReschedule
      ? "The provider does not allow rescheduling for this class. Contact them directly if you need help."
      : cutoffPassed(b, b.resCutoffH)
        ? `The rescheduling window for this class has closed — rescheduling closes ${hoursLabel(b.resCutoffH)} before the session.`
        : null;

  const party = (b: BookingItem) => b.places.length > 1;

  // Pay for a still-waitlisted booking that now has a seat free (00100).
  // Checks out the existing booking rows — the webhook confirms them. If the
  // class filled between the page loading and this click, the route says so.
  async function payToClaim(b: BookingItem) {
    if (!b.claimIds.length) return;
    setBusyId(b.id);
    try {
      const allWaitlisted = b.places.every((p) => p.status === "waitlisted");
      const body =
        b.groupId && allWaitlisted ? { group_id: b.groupId } : { booking_id: b.claimIds[0] };
      const { url } = await apiPost<{ url?: string }>("/api/bookings/checkout", body);
      if (url) window.location.href = url;
      else setNotice("Couldn't start payment just now — please try again.");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Couldn't start payment — please try again.");
    } finally {
      setBusyId(null);
    }
  }

  async function doCancel(b: BookingItem) {
    const seats = b.places.length;
    // What a cancellation actually gives back is the vendor's policy (00099)
    // and is shown on the booking afterwards — the confirm step just says so
    // rather than promising a specific outcome up front.
    const tail = "Eligibility for refund or make up tokens is per vendor policy.";
    const q = party(b)
      ? `Cancel all ${seats} places for ${b.title}? ${tail}`
      : `Cancel your booking for ${b.title}? ${tail}`;
    if (!window.confirm(q)) return;
    setBusyId(b.id);
    // A Wix-linked booking's cancellation has to reach Wix too (see
    // /api/wix/bookings/cancel), so it also frees the seat there instead of
    // leaving it stale — the plain RPCs only ever touched local data.
    if (b.isWixLinked) {
      try {
        await apiPost("/api/wix/bookings/cancel", party(b) && b.groupId ? { groupId: b.groupId } : { bookingId: b.id });
        onChanged?.();
      } catch (e) {
        setNotice(e instanceof Error ? e.message : "Couldn't cancel this booking — please try again.");
      } finally {
        setBusyId(null);
      }
      return;
    }
    const { error } = party(b) && b.groupId
      ? await supabase.rpc("cancel_booking_group", { p_group_id: b.groupId })
      : await supabase.rpc("cancel_booking", { p_booking_id: b.id });
    setBusyId(null);
    if (error) setNotice(cleanRpcErrorMessage(error));
    else onChanged?.();
  }

  async function renameGuest(bookingId: string, name: string) {
    const { error } = await supabase.rpc("rename_booking_guest", {
      p_booking_id: bookingId,
      p_name: name.trim() || null,
    });
    if (error) setNotice(cleanRpcErrorMessage(error));
    else onChanged?.();
  }

  /** Cancel one seat of a party, leaving the rest booked. Same policy gate
   *  as the whole-booking cancel; the per-row compensation trigger returns
   *  that seat's own credit / make-up token. */
  async function cancelPlace(b: BookingItem, bookingId: string, name: string) {
    const why = cancelBlockReason(b);
    if (why) { setNotice(why); return; }
    if (!window.confirm(`Cancel ${name}'s place on ${b.title}? Eligibility for refund or make up tokens is per vendor policy.`)) return;
    setBusyId(b.id);
    const { error } = await supabase.rpc("cancel_booking", { p_booking_id: bookingId });
    setBusyId(null);
    if (error) setNotice(cleanRpcErrorMessage(error));
    else onChanged?.();
  }

  async function openReschedule(b: BookingItem) {
    if (!b.activityId) return;
    setReschedFor(b);
    const { data } = await supabase
      .from("activity_sessions")
      .select("id, starts_at")
      .eq("activity_id", b.activityId)
      .gte("starts_at", new Date().toISOString())
      .order("starts_at")
      .limit(12);
    setReschedSessions((data ?? []).filter((s) => s.starts_at !== b.startsAt));
  }

  async function doReschedule(newSessionId: string) {
    if (!reschedFor) return;
    setBusyId(reschedFor.id);
    // A Wix-linked class's reschedule has to move the booking in Wix too
    // (see /api/wix/bookings/reschedule) — one call for the whole party
    // (every seat shares one Wix booking), not one RPC call per seat.
    if (reschedFor.isWixClass) {
      try {
        await apiPost("/api/wix/bookings/reschedule", { bookingId: reschedFor.id, newSessionId });
        onChanged?.();
      } catch (e) {
        setNotice(e instanceof Error ? e.message : "Couldn't move this booking — please try again.");
      } finally {
        setBusyId(null);
        setReschedFor(null);
      }
      return;
    }
    // A party moves every seat to the same new session, one call each.
    let error: { message: string; code?: string | null } | null = null;
    for (const id of reschedFor.allIds) {
      const res = await supabase.rpc("reschedule_booking", { p_booking_id: id, p_new_session_id: newSessionId });
      if (res.error) { error = res.error; break; }
    }
    setBusyId(null);
    setReschedFor(null);
    if (error) setNotice(cleanRpcErrorMessage(error));
    else onChanged?.();
  }

  if (items.length === 0) return <EmptyPanel icon="calendar" copy={emptyCopy} cta="Browse activities" href="/explore" />;
  // Non-cancelled classes with a scheduled time can be exported as one calendar.
  const exportable = items.filter((b) => b.startsAt && b.status !== "cancelled");
  return (
    <div className="mt-4 space-y-3">
      {exportable.length > 0 && (
        <div className="flex flex-wrap justify-end gap-2">
          {/* Calendar sync and the exportable schedule are Plus features. */}
          {isPlus ? (
            <button
              type="button"
              onClick={() => setExporting(true)}
              className="flex items-center gap-1.5 rounded-[9px] border border-[#FED7E4] px-3 py-1.5 text-xs font-bold text-[#FFC1D6] hover:bg-[#FFF5F8]"
              title="Pick a date range, then save as PDF or add to your calendar"
            >
              <Icon name="calendar" className="h-3.5 w-3.5" /> Export schedule
            </button>
          ) : (
            <a
              href="/pricing"
              className="flex items-center gap-1.5 rounded-[9px] border border-[#EBE3E5] bg-[#FAF7F7] px-3 py-1.5 text-xs font-bold text-[#6D7486] hover:border-baby-pink hover:text-[#FFC1D6]"
              title="Calendar sync and PDF export are Plus features"
            >
              <Icon name="lock" className="h-3.5 w-3.5" /> Calendar &amp; PDF export — Plus
            </a>
          )}
        </div>
      )}
      {exporting && (
        <ExportScheduleDialog items={exportable} onClose={() => setExporting(false)} />
      )}
      {items.map((b) => {
        const cancelWhy = cancelBlockReason(b);
        const reschedWhy = reschedBlockReason(b);
        return (
          <div
            key={b.id}
            id={`row-${b.id}`}
            className={`rounded-[12px] border border-[#EBE3E5] bg-white p-3 shadow-card transition hover:border-baby-pink ${
              flashing && highlightId != null && (b.id === highlightId || b.allIds.includes(highlightId)) ? HIGHLIGHT_RING : ""
            }`}
          >
            {/* A removed activity's own detail page is gone (unpublished,
                slug renamed by unlinkWixActivities) — send those clicks to
                the activities list instead of a dead link. */}
            <a href={b.slug && !b.removed ? `/activity?slug=${b.slug}` : "/explore"} className="flex items-start gap-3 sm:items-center sm:gap-4">
              <img src={b.image} onError={fallbackToPlaceholder} alt="" width={64} height={64} loading="lazy" decoding="async" className="h-14 w-14 flex-shrink-0 rounded-[10px] object-cover sm:h-16 sm:w-16" />
              <div className="min-w-0 flex-1">
                <h3 className="truncate font-black">{b.title}</h3>
                {b.when && (
                  <p className="flex items-center gap-1.5 text-sm font-semibold text-[#59658d]">
                    <Icon name="calendar" className="h-3.5 w-3.5 shrink-0 text-baby-lilac" />
                    {b.when}
                  </p>
                )}
                {b.venue && (
                  <p className="flex items-center gap-1.5 text-sm font-semibold text-[#59658d]">
                    <Icon name="pin" className="h-3.5 w-3.5 shrink-0 text-baby-lilac" />
                    <span className="truncate">{b.venue}</span>
                  </p>
                )}
                {/* QA 24/08: the teacher and studio the vendor set on this
                    session — the parent could not see them anywhere. */}
                {b.staff && (
                  <p className="flex items-center gap-1.5 text-sm font-semibold text-[#59658d]">
                    <Icon name="user" className="h-3.5 w-3.5 shrink-0 text-baby-lilac" />
                    <span className="truncate">{b.staff}</span>
                  </p>
                )}
                {/* On a phone the status chip sits under the title so the
                    header row isn't three things fighting for ~340px. */}
                <BookingStatusChip b={b} className="mt-1.5 sm:hidden" />
              </div>
              {/* Adding a single class to your own calendar is free; only the
                  bulk date-range export + PDF above is a Plus feature. */}
              {b.startsAt && b.status !== "cancelled" && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    downloadBookingIcs({ id: b.id, title: b.title, startsAt: b.startsAt!, endsAt: b.endsAt, venue: b.venue });
                  }}
                  className="hidden items-center gap-1 rounded-[9px] border border-[#FED7E4] px-3 py-1.5 text-xs font-bold text-[#FFC1D6] hover:bg-[#FFF5F8] sm:flex"
                  title="Add to calendar"
                >
                  <Icon name="calendar" className="h-3.5 w-3.5" /> Add to calendar
                </button>
              )}
              <BookingStatusChip b={b} className="hidden shrink-0 sm:flex" />
            </a>
            {party(b) && (
              <PartyPlaces
                b={b}
                onRename={renameGuest}
                onCancelPlace={(id, name) => cancelPlace(b, id, name)}
                editable={b.status !== "cancelled" && upcoming(b)}
                cancelWhy={cancelWhy}
              />
            )}
            {b.canClaim && (
              <div className="mt-2 flex flex-col gap-1.5 border-t border-[#FAF7F7] pt-2.5 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs font-bold text-palette-greenInk">
                  A spot has opened up on this class — pay to confirm it before it's taken.
                </p>
                <button
                  type="button"
                  disabled={busyId === b.id}
                  onClick={() => payToClaim(b)}
                  className="w-full rounded-[9px] bg-baby-cta px-4 py-2.5 text-sm font-bold text-white hover:opacity-90 disabled:opacity-60 sm:w-auto sm:py-1.5 sm:text-xs"
                >
                  {busyId === b.id ? "Starting…" : "Pay now"}
                </button>
              </div>
            )}
            {upcoming(b) && (
              <div className="mt-2 flex flex-col gap-2 border-t border-[#FAF7F7] pt-2 sm:flex-row sm:justify-end">
                <button
                  type="button"
                  disabled={busyId === b.id}
                  onClick={() => (reschedWhy ? setNotice(reschedWhy) : openReschedule(b))}
                  className={`w-full rounded-[9px] px-3 py-2.5 text-sm font-bold sm:w-auto sm:py-1.5 sm:text-xs ${
                    reschedWhy
                      ? "cursor-not-allowed border border-[#EBE3E5] bg-[#FAF7F7] text-[#6D7486]"
                      : "border border-[#FED7E4] text-[#FFC1D6] hover:bg-[#FFF5F8]"
                  }`}
                  title={reschedWhy ?? "Move this booking to another session"}
                >
                  Reschedule
                </button>
                <button
                  type="button"
                  disabled={busyId === b.id}
                  onClick={() => (cancelWhy ? setNotice(cancelWhy) : doCancel(b))}
                  className={`w-full rounded-[9px] px-3 py-2.5 text-sm font-bold sm:w-auto sm:py-1.5 sm:text-xs ${
                    cancelWhy
                      ? "cursor-not-allowed border border-[#EBE3E5] bg-[#FAF7F7] text-[#6D7486]"
                      : "border border-[#FED7E4] text-[#FFC1D6] hover:bg-[#FFF5F8]"
                  }`}
                  title={cancelWhy ?? (party(b) ? `Cancel all ${b.places.length} places` : "Cancel this booking")}
                >
                  {busyId === b.id ? "Working…" : party(b) ? `Cancel all ${b.places.length}` : "Cancel booking"}
                </button>
              </div>
            )}
            {b.status === "cancelled" && b.compensation && (
              <div className="mt-2 flex items-start gap-1.5 border-t border-[#FAF7F7] pt-2 text-xs font-semibold text-[#59658d]">
                <Icon name={b.compensation === "none" ? "bell" : "gift"} className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#FFC1D6]" />
                <span>
                  {b.compensation === "none"
                    ? "Payment for this activity is non-refundable, if cancelled — no credit or make-up token was issued."
                    : b.compensation === "token"
                    ? `Replaced with ${b.places.length > 1 ? `${b.places.length} make-up tokens` : "a make-up token"} you can use on another class — ${b.places.length > 1 ? "they don't" : "it doesn't"} expire.`
                    : `${b.places.length > 1 ? `${b.places.length} class credits have` : "1 class credit has"} been returned to your package.`}
                </span>
              </div>
            )}
          </div>
        );
      })}

      {/* Explanatory pop-up for unavailable actions / errors */}
      {notice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" onClick={() => setNotice(null)}>
          <div className="w-full max-w-sm rounded-[16px] bg-white p-6 text-center shadow-card" onClick={(e) => e.stopPropagation()}>
            <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-amber-50 text-palette-yellow"><Icon name="bell" className="h-6 w-6" /></span>
            <p className="mt-4 font-semibold text-[#3f4b78]">{notice}</p>
            <Button type="button" className="mt-5 w-full" onClick={() => setNotice(null)}>Got it</Button>
          </div>
        </div>
      )}

      {/* Reschedule picker */}
      {reschedFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" onClick={() => setReschedFor(null)}>
          <div className="w-full max-w-md rounded-[16px] bg-white p-6 shadow-card" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-black">Reschedule {reschedFor.title}</h3>
            <p className="mt-1 text-sm font-semibold text-[#59658d]">Pick a new session — your booking moves instantly.</p>
            <div className="mt-4 max-h-64 space-y-2 overflow-auto">
              {reschedSessions.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => doReschedule(s.id)}
                  className="flex w-full items-center justify-between rounded-[10px] border border-[#EBE3E5] px-4 py-2.5 text-left text-sm font-bold text-[#3f4b78] hover:border-baby-pink hover:bg-[#FFF5F8]"
                >
                  {sgDateTime(s.starts_at)}
                  <Icon name="calendar" className="h-4 w-4 text-[#FFC1D6]" />
                </button>
              ))}
              {reschedSessions.length === 0 && <p className="py-4 text-center text-sm font-semibold text-[#6D748D]">No other upcoming sessions for this class.</p>}
            </div>
            <Button type="button" variant="outline" className="mt-4 w-full" onClick={() => setReschedFor(null)}>Close</Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Placeholder cards shown while the bookings fetch is still in flight, so
 *  the Bookings / Past tabs never flash their empty state on load. */
function BookingsSkeleton({ rows = 2 }: { rows?: number }) {
  return (
    <div className="mt-4 space-y-3" aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 rounded-[12px] border border-[#EBE3E5] bg-white p-3 shadow-card">
          <div className="h-14 w-14 shrink-0 animate-pulse rounded-[10px] bg-[#F3EDF0] sm:h-16 sm:w-16" />
          <div className="flex-1 space-y-2">
            <div className="h-4 w-2/5 animate-pulse rounded bg-[#F3EDF0]" />
            <div className="h-3 w-3/5 animate-pulse rounded bg-[#F6F1F3]" />
            <div className="h-3 w-1/3 animate-pulse rounded bg-[#F6F1F3]" />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyPanel({ icon, copy, cta, href }: { icon: string; copy: string; cta?: string; href?: string }) {
  return (
    <div className="mt-4 rounded-[14px] border border-dashed border-[#DCD2D5] bg-white p-10 text-center">
      <Icon name={icon} className="mx-auto h-8 w-8 text-[#C9BAC2]" />
      <p className="mt-3 font-semibold text-[#68718f]">{copy}</p>
      {cta && href && <Button href={href} variant="outline" className="mt-4">{cta}</Button>}
    </div>
  );
}
