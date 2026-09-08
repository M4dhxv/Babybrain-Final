import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  ActivityCard,
  AnimalAvatar,
  BrandStacked,
  Button,
  CategoryTile,
  DateInput,
  Footer,
  Icon,
  PageShell,
  PlusFeatureDialog,
  ConfirmDialog,
  SectionTitle,
} from "../components/ui";
import { SelectField, Opt } from "../components/SelectField";
import { EnquiryChat } from "../components/EnquiryChat";
import { ClassGroupChat } from "../components/ClassGroupChat";
import RedirectToLanding from "../components/RedirectToLanding";
import {
  ActivityCardGridSkeleton,
  BookingPageSkeleton,
  JourneyStatsSkeleton,
  ListRowsSkeleton,
  MessagesSkeleton,
} from "../components/Skeletons";
import { useAuth } from "../auth/AuthProvider";
import { useUnreadMessages } from "../lib/chat";
import { supabase } from "../lib/supabase";
import { apiGet, apiPost } from "../lib/api";
import { cleanRpcErrorMessage } from "../lib/errors";
import { goTo, getParam } from "../lib/nav";
import { sgDateTime, sgDay, sgTime, sgDayRange, courseStrands } from "../lib/schedule";
import { downloadBookingIcs, downloadScheduleIcs } from "../lib/ics";
import { downloadSchedulePdf, withinRange } from "../lib/schedule-pdf";
import {
  useActivityDetail,
  usePlan,
  useRecommendations,
  useJourney,
  invalidatePlan,
  primePlan,
  toCard,
} from "../lib/data";
import { formatChildAge, formatAgeRange, formatDuration, regionLabel, ageInMonths } from "../lib/database.types";
import type { ActivitySession, Child, Gender, ProviderPolicy } from "../lib/database.types";
import { CHILD_AVATARS, PARENT_AVATARS, type AvatarOption } from "../lib/avatars";
import { dobError, postcodeError } from "../lib/validation";
import { Chip, TIME_CHIPS, BUDGET_CHIPS, REGION_FILTERS, budgetRange } from "./prefChips";

const MessagesTab = lazy(() =>
  import("../components/MessagesTab").then((m) => ({ default: m.MessagesTab }))
);

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
type NotifItem = { id: string; title: string; body: string; read_at: string | null; created_at: string };
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
}: {
  kids: { id: string; name: string }[];
  value: string | null;
  onChange: (id: string | null) => void;
  label?: string;
}) {
  if (kids.length < 2) return null;
  return (
    <label className="mb-4 flex items-center gap-2 text-sm font-bold text-[#4a5685]">
      {label}
      <SelectField
        value={value ?? "all"}
        onChange={(v) => onChange(v === "all" ? null : v)}
        aria-label={label}
        className="h-10 px-3 text-sm font-bold text-[#4a5685]"
      >
        <Opt value="all">All children (split out)</Opt>
        {kids.map((k) => (
          <Opt key={k.id} value={k.id}>{k.name}</Opt>
        ))}
      </SelectField>
    </label>
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

/** One make-up token, shared by the flat and the split-by-child lists. */
function TokenRow({ t }: { t: TokenItem }) {
  return (
    <div className="flex flex-col gap-3 rounded-[12px] border border-[#EBE3E5] bg-white p-4 shadow-card sm:flex-row sm:items-center sm:gap-4">
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
  const clickable = p.status !== "expired" && p.remaining > 0;
  const Card = clickable ? "a" : "div";
  return (
    <Card
      {...(clickable ? { href: p.bookHref, title: "Book a class with this pack" } : {})}
      className={`flex items-center gap-4 rounded-[12px] border border-[#EBE3E5] bg-white p-4 shadow-card ${clickable ? "transition hover:border-baby-pink" : "opacity-60"}`}
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
      <img src={b.image} alt="" width={56} height={56} loading="lazy" decoding="async" className="h-14 w-14 rounded-[10px] object-cover" />
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
  const isUpcoming = (b: BookingItem) => !!b.startsAt && new Date(b.startsAt).getTime() >= now && b.status !== "cancelled";
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

/** Grid of avatar choices. Storing the chosen option's seed is all we need to
 *  reproduce the picture; `null` means "pick one for me from my name". */
function AvatarPicker({
  options,
  value,
  onChange,
  kind,
  fallbackSeed,
  gender,
}: {
  options: AvatarOption[];
  value: string | null;
  onChange: (seed: string | null) => void;
  kind: "child" | "parent";
  fallbackSeed?: string;
  /** Drives the "Choose for me" swatch, so it previews the girl/boy default. */
  gender?: string | null;
}) {
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {[null, ...options.map((o) => o.seed)].map((seed) => {
        const on = value === seed;
        const label = seed ? options.find((o) => o.seed === seed)?.label ?? seed : "Choose for me";
        return (
          <button
            key={seed ?? "default"}
            type="button"
            title={label}
            aria-label={label}
            aria-pressed={on}
            onClick={() => onChange(seed)}
            className={`rounded-full p-0.5 transition ${on ? "ring-2 ring-baby-pink" : "ring-1 ring-[#F4EFF0] hover:ring-[#FFC1D6]"}`}
          >
            <AnimalAvatar seed={seed ?? fallbackSeed} kind={kind} gender={seed ? null : gender} className="h-11 w-11" />
          </button>
        );
      })}
    </div>
  );
}

/** Edit an existing parent profile.
 *
 *  QA: "When you click edit profile, the form should be pre-populated with what
 *  you have completed before rather than having to do it all again" and "Tried
 *  to edit profile and it added a child instead". Both came from Edit Profile
 *  pointing at /onboarding — the sign-up form, which always inserts a new
 *  child. Children are managed on their own tab; this page never creates one.
 */
export function EditProfilePage() {
  const { session, profile, children: kids, loading, refresh } = useAuth();
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [postcode, setPostcode] = useState("");
  const [avatarSeed, setAvatarSeed] = useState<string | null>(null);
  const [regions, setRegions] = useState<string[]>([]);
  const [days, setDays] = useState<string[]>([]);
  const [times, setTimes] = useState<string[]>([]);
  // QA: "Under account, edit profile, can only select one budget — should be
  // able to select multiple." Sign-up already worked this way: the parent
  // ticks any number of bands and we store the span they cover.
  const [budgets, setBudgets] = useState<string[]>([]);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Prefill from what the parent has already told us.
  useEffect(() => {
    if (!profile) return;
    setFullName(profile.full_name ?? "");
    setPhone(profile.phone ?? "");
    setPostcode(profile.postal_code ?? "");
    setAvatarSeed(profile.avatar_seed ?? null);
  }, [profile]);

  useEffect(() => {
    if (!session) return;
    supabase
      .from("user_preferences")
      .select("preferred_days, preferred_times, preferred_regions, budget_min, budget_max")
      .eq("user_id", session.user.id)
      .maybeSingle()
      .then(({ data }) => {
        if (data) {
          setDays(data.preferred_days ?? []);
          setTimes(data.preferred_times ?? []);
          setRegions(data.preferred_regions ?? []);
          // Stored as one min/max span; tick every band that span covers.
          const lo = data.budget_min;
          const hi = data.budget_max;
          if (lo != null || hi != null) {
            setBudgets(
              BUDGET_CHIPS.filter(
                ([, , bLo, bHi]) =>
                  (lo == null || (bHi ?? Infinity) > lo) && (hi == null || (bLo ?? 0) < hi)
              ).map(([k]) => k)
            );
          }
        }
        setReady(true);
      });
  }, [session]);

  const toggle = (list: string[], v: string, set: (x: string[]) => void) =>
    set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const input = "h-11 w-full rounded-[10px] border border-[#FED7E4] px-3 text-sm font-semibold";
  const weekdayKeys = ["mon", "tue", "wed", "thu", "fri"];
  const weekendKeys = ["sat", "sun"];
  const weekdaysOn = weekdayKeys.every((d) => days.includes(d));
  const weekendOn = weekendKeys.every((d) => days.includes(d));

  async function save() {
    if (!session) return;
    if (!fullName.trim()) return setError("Please add your full name.");
    const postcodeProblem = postcodeError(postcode);
    if (postcodeProblem) return setError(postcodeProblem);
    setBusy(true);
    setError(null);
    const { error: pErr } = await supabase
      .from("parent_profiles")
      .update({
        full_name: fullName.trim(),
        phone: phone.trim() || null,
        postal_code: postcode.trim(),
        avatar_seed: avatarSeed,
      })
      .eq("id", session.user.id);
    // QA: "interests show up under the parent section — remove, interests are
    // associated with the child". They still drive parent-level
    // recommendations, so we keep the column in step with the children's own
    // interests rather than asking for them twice.
    const { error: prefErr } = await supabase
      .from("user_preferences")
      .update({
        preferred_days: days as never,
        preferred_times: times as never,
        preferred_regions: regions as never,
        interests: [...new Set(kids.flatMap((c) => c.interests))],
        ...budgetRange(budgets),
      })
      .eq("user_id", session.user.id);
    setBusy(false);
    if (pErr || prefErr) return setError((pErr ?? prefErr)!.message);
    await refresh();
    setSaved(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  if (!loading && !session) return <RedirectToLanding />;

  return (
    <PageShell active="/profile">
      <main className="mx-auto max-w-[680px] px-6 py-6">
        <a href="/profile" className="text-sm font-bold text-baby-lilac">← Back to my account</a>
        <h1 className="mt-3 text-[30px] font-black">Edit your profile</h1>
        <p className="mt-1 text-sm font-semibold text-[#44507b]">Update your details and what you'd like us to suggest.</p>

        {saved && (
          <p className="mt-4 rounded-[10px] bg-[#F1FBEF] px-4 py-3 text-sm font-bold text-palette-green">
            Your profile has been updated.
          </p>
        )}

        <section className="mt-4 rounded-[14px] border border-[#FEE9D7] bg-white p-5">
          <h2 className="font-black">Your avatar</h2>
          <p className="mt-1 text-xs font-semibold text-[#6D748D]">Pick the one you like — it shows on your account and in class chats.</p>
          <AvatarPicker
            options={PARENT_AVATARS}
            value={avatarSeed}
            onChange={setAvatarSeed}
            kind="parent"
            fallbackSeed={fullName}
          />
        </section>

        <section className="mt-4 rounded-[14px] border border-[#FEE9D7] bg-white p-5">
          <h2 className="font-black">Your details</h2>
          <div className="mt-3 space-y-3">
            <div><label className="mb-1 block text-sm font-black">Full name</label><input className={input} value={fullName} onChange={(e) => setFullName(e.target.value)} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="mb-1 block text-sm font-black">Phone</label><input className={input} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="8123 4567" /></div>
              <div><label className="mb-1 block text-sm font-black">Postcode</label><input className={input} inputMode="numeric" maxLength={6} value={postcode} onChange={(e) => setPostcode(e.target.value.replace(/\D/g, ""))} /></div>
            </div>
            <div>
              <p className="text-xs font-bold uppercase tracking-wide text-[#6D748A]">Email</p>
              <p className="font-black">{session?.user.email}</p>
              <p className="text-xs font-semibold text-[#6D748D]">Contact us if you need to change the email on your account.</p>
            </div>
          </div>
        </section>

        <section className="mt-4 rounded-[14px] border border-[#FEE9D7] bg-white p-5">
          <h2 className="flex items-center gap-2 font-black"><Icon name="pin" className="h-4 w-4 text-baby-pink" /> Areas you'd like activities in</h2>
          <div className="mt-2 flex flex-wrap gap-2">
            {REGION_FILTERS.map(([v, l]) => (
              <Chip key={v} on={regions.includes(v)} onClick={() => toggle(regions, v, setRegions)}>{l}</Chip>
            ))}
          </div>

          <h2 className="mt-5 flex items-center gap-2 font-black"><Icon name="heart" className="h-4 w-4 text-baby-pink" /> Your preferences</h2>
          <div className="mt-2 flex flex-wrap gap-2">
            <Chip
              on={weekdaysOn}
              onClick={() => setDays((d) => (weekdaysOn ? d.filter((x) => !weekdayKeys.includes(x)) : [...new Set([...d, ...weekdayKeys])]))}
            >
              Weekdays
            </Chip>
            <Chip
              on={weekendOn}
              onClick={() => setDays((d) => (weekendOn ? d.filter((x) => !weekendKeys.includes(x)) : [...new Set([...d, ...weekendKeys])]))}
            >
              Weekend
            </Chip>
            {TIME_CHIPS.map(([v, l]) => <Chip key={v} on={times.includes(v)} onClick={() => toggle(times, v, setTimes)}>{l}</Chip>)}
            {BUDGET_CHIPS.map(([k, l]) => (
              <Chip key={k} on={budgets.includes(k)} onClick={() => toggle(budgets, k, setBudgets)}>{l}</Chip>
            ))}
          </div>

        </section>

        <section className="mt-4 flex items-center justify-between gap-3 rounded-[14px] border border-[#FEE9D7] bg-[#FFF5F8] p-5">
          <div>
            <h2 className="font-black">Your children</h2>
            <p className="mt-1 text-sm font-semibold text-[#59658d]">Add, edit or remove a child on their own tab — editing your profile never changes them.</p>
          </div>
          <Button href="/profile?tab=children" variant="outline" className="shrink-0"><Icon name="people" className="h-4 w-4" /> Manage children</Button>
        </section>

        {error && (
          <p role="alert" className="mt-4 rounded-[10px] border border-[#FED7E4] bg-[#FEEBF2] px-4 py-3 text-sm font-bold text-baby-cta">{error}</p>
        )}
        <div className="mt-4 flex gap-3">
          <Button type="button" onClick={save} disabled={busy || !ready}>{busy ? "Saving…" : "Save changes"}</Button>
          <Button href="/profile" variant="outline">Cancel</Button>
        </div>
      </main>
      <Footer />
    </PageShell>
  );
}

export function ProfilePage() {
  const { session, profile, children, loading, signOut, refresh } = useAuth();
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
  const [billingBusy, setBillingBusy] = useState(false);
  const tab = getParam("tab") || "overview";
  /* Unread badge on the Messages tab (QA 04/09). Free parents can read their
     conversations now, so the badge is worth showing to them too — an unread
     message they can open is exactly what it is for. */
  const unreadMessages = useUnreadMessages(Boolean(session));

  // Below lg the nav is a left-hand drawer, not a stacked block. Landing on the
  // profile (the Overview tab) auto-reveals it: it slides in, holds for 4s,
  // then rolls back. On the other tabs it stays closed until the edge handle
  // (› / ‹) or a tap on the dimmed page opens it. At lg the Tailwind `lg:`
  // classes drop the fixed positioning and it's a static sidebar again.
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    // Client-side nav keeps this page mounted across tab changes, so the drawer
    // has to be told to close — a full reload used to do it for free.
    setMenuOpen(false);
    if (tab !== "overview") return;
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
  function loadBookings() {
    apiGet<{
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
          } | null;
        } | null;
        compensation: "token" | "credit" | "none" | null;
        paid_with: "token" | "credit" | "cash" | "free";
        refund_mode: "refund" | "none";
        can_claim?: boolean;
      }>;
    }>("/api/customer/bookings")
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
              image: act?.image_urls?.[0] ?? `${import.meta.env.BASE_URL}assets/crops/activity-play.png`,
              startsAt: s?.starts_at ?? null,
              endsAt: s?.ends_at ?? null,
              venue: s?.provider_locations?.address || s?.provider_locations?.name || act?.address || "",
              // QA 24/08: "they should be able to see under bookings".
              staff: [s?.teacher_name, s?.studio].filter(Boolean).join(" · "),
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
    const { data, error } = await supabase
      .from("package_purchases")
      .select(
        "id, credits_total, credits_remaining, status, expires_at, packages(name, activity_ids), providers(business_name)"
      )
      .order("created_at", { ascending: false });
    if (error) {
      console.warn("[packages] load failed:", error.message);
      setPackagesLoaded(true);
      return;
    }
    const rows = (data ?? []) as unknown as Array<{
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
    supabase
      .from("favorites")
      /* Upcoming sessions ride along so the card can show the next class
         rather than "Schedule TBC" (QA 24/08). Filtered to the future on the
         server — a Wix-linked class can carry hundreds of past slots, and a
         parent with twenty favourites would otherwise pull thousands of rows
         to render twenty dates. */
      .select(
        "activities(*, activity_categories(name), activity_sessions(starts_at, ends_at))"
      )
      .gte("activities.activity_sessions.starts_at", new Date().toISOString())
      .then(({ data }) => {
        setFavs(
          (data ?? [])
            .map((f) => {
              const a = f.activities as unknown as
                | (Parameters<typeof toCard>[0] & { activity_categories?: { name: string } })
                | null;
              return a ? toCard({ ...a, category_name: a.activity_categories?.name }) : null;
            })
            .filter((x): x is ReturnType<typeof toCard> => Boolean(x))
        );
        setFavsLoaded(true);
      });

    // Which children each favourite is assigned to. A favourite with no rows is
    // saved for the whole family, which is what every pre-existing favourite is.
    supabase
      .from("favorite_children")
      .select("activity_id, child_id")
      .then(({ data }) => {
        const m: Record<string, string[]> = {};
        for (const r of (data ?? []) as { activity_id: string; child_id: string }[]) {
          (m[r.activity_id] ??= []).push(r.child_id);
        }
        setFavChildren(m);
      });

    loadBookings();

    supabase
      .from("reviews")
      .select("id, rating, comment, provider_response, activities(title, slug)")
      .order("created_at", { ascending: false })
      .then(({ data }) => {
        const rows = (data ?? []) as unknown as Array<{
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

    supabase
      .from("notifications")
      .select("id, title, body, read_at, created_at")
      .order("created_at", { ascending: false })
      .then(({ data }) => {
        setNotifications((data ?? []) as unknown as NotifItem[]);
        setNotifsLoaded(true);
      });

    loadPackages();

    supabase
      .from("favorite_providers")
      .select("provider_id, providers(business_name)")
      .then(({ data }) => {
        const rows = (data ?? []) as unknown as Array<{ provider_id: string; providers: { business_name: string } | null }>;
        setSavedProviders(rows.map((r) => ({ id: r.provider_id, name: r.providers?.business_name ?? "Provider" })));
      });

    (async () => {
      const { data } = await supabase
        .from("make_up_tokens")
        .select("id, status, created_at, expires_at, origin_booking_id, child_id, providers(business_name)")
        .order("created_at", { ascending: false });
      const rows = (data ?? []) as unknown as Array<{
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
        const { data: bks } = await supabase
          .from("bookings")
          .select("id, activity_sessions(activities(slug, title))")
          .in("id", originIds);
        for (const b of (bks ?? []) as unknown as Array<{ id: string; activity_sessions: { activities: { slug: string; title: string } | null } | null }>) {
          const act = b.activity_sessions?.activities;
          if (act) originByBooking.set(b.id, { slug: act.slug ?? null, title: act.title ?? null });
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
          primePlan(p.plan);
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
  // A class is "past" once its start time has gone by. Attendance decides
  // which of the two past lists it lands in.
  const now = Date.now();
  const isPast = (b: BookingItem) =>
    b.status !== "cancelled" && !!b.startsAt && new Date(b.startsAt).getTime() < now;
  const childFiltered = childFilter
    ? bookings.filter((b) => b.childId === childFilter)
    : bookings;
  const upcomingBookings = childFiltered.filter((b) => !isPast(b));
  const pastBookings = childFiltered.filter(isPast);
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
    }
  }

  return (
    <PageShell active="/profile">
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
        {/* Edge handle — a chunky chevron that points right (>) into the page
            when closed and left (<) toward the drawer when open. It rides the
            drawer's edge as it slides. Mobile only. */}
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
            transform: `translateY(-50%)${handleAdjusting ? " scale(1.12)" : ""}`,
          }}
          // touch-none is unconditional: it has to be set before the gesture
          // starts, or the browser has already claimed the touch as a scroll.
          className={`fixed z-50 -ml-px grid h-11 w-7 touch-none select-none place-items-center rounded-r-[10px] bg-white text-baby-cta shadow-[4px_1px_10px_rgba(17,26,76,0.10)] ease-out lg:hidden ${
            handleAdjusting
              ? "ring-2 ring-[#FA4D8D]/50 transition-transform"
              : "transition-[left] duration-300"
          } ${menuOpen ? "left-[62%]" : "left-0"}`}
        >
          <Icon name="chevron" strokeWidth={3} className={`h-5 w-5 ${menuOpen ? "rotate-180" : ""}`} />
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
                    {key === "messages" && unreadMessages > 0 && !locked && (
                      <span className="ml-auto grid h-5 min-w-[20px] shrink-0 place-items-center rounded-full bg-baby-cta px-1.5 text-[11px] font-black text-white">
                        {unreadMessages > 9 ? "9+" : unreadMessages}
                      </span>
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
            {recsLoading ? (
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
              <ChildSelect kids={children} value={childFilter} onChange={setChildFilter} />
              {!bookingsLoaded ? (
                <BookingsSkeleton />
              ) : splitByChild ? (
                <div className="space-y-8">
                  {groupByChild(upcomingBookings, children).map((g) => (
                    <section key={g.key}>
                      <h2 className="mb-3 border-b border-[#F4EFF0] pb-2 text-[19px] font-black">{g.name}</h2>
                      <BookingList items={g.items} emptyCopy="" onChanged={loadBookings} isPlus={isPlus} />
                    </section>
                  ))}
                  {upcomingBookings.length === 0 && (
                    <BookingList items={[]} emptyCopy="You haven't booked any upcoming classes yet." onChanged={loadBookings} isPlus={isPlus} />
                  )}
                </div>
              ) : (
                <BookingList items={upcomingBookings} emptyCopy="You haven't booked any upcoming classes yet." onChanged={loadBookings} isPlus={isPlus} />
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
                  Some pack's credits can be spent on any of your children — this shows the packs {filterChild.name} has used, plus any still untouched.
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
                    <div key={activity.id}>
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
                  {notifications.map((n) => (
                    <div key={n.id} className={`rounded-[12px] border p-4 shadow-card ${n.read_at ? "border-[#EBE3E5] bg-white" : "border-[#DAEEFB] bg-[#FFF5F8]"}`}>
                      <div className="flex items-start gap-2">
                        {!n.read_at && <span className="mt-1.5 h-2 w-2 flex-shrink-0 rounded-full bg-baby-pink" />}
                        <div>
                          <p className="font-black">{n.title}</p>
                          {n.body && <p className="mt-0.5 text-sm font-semibold text-[#59658d]">{n.body}</p>}
                          <p className="mt-1 text-xs font-semibold text-[#6D748A]">{sgDateTime(n.created_at)}</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === "settings" && (
            <div>
              <h1 className="mb-4 text-[26px] font-black">Settings</h1>

              {getParam("billing") === "success" && (
                <div className="mb-4 rounded-[12px] border border-green-300 bg-green-50 px-4 py-3 text-sm font-bold text-palette-green">
                  🎉 Welcome to Plus! Your subscription is active — your first month is free.
                </div>
              )}

              {/* Plan & Billing */}
              <div className="mb-4 rounded-[14px] border border-[#EBE3E5] bg-white p-6 shadow-card">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-xs font-bold uppercase tracking-wide text-[#6D748A]">Plan</p>
                    <p className="mt-1 flex flex-wrap items-center gap-2 text-lg font-black">
                      <Icon name={billingPlan?.plan === "plus" ? "star" : "heart"} className="h-5 w-5 text-baby-pink" />
                      {billingPlan?.plan === "plus" ? "BabyBrain Plus" : "Free"}
                      {billingPlan?.status === "trialing" && (
                        <span className="rounded-full bg-[#FED7E4] px-2 py-0.5 text-xs font-bold text-baby-cta">Free trial</span>
                      )}
                      {billingPlan?.cancel_at_period_end && (
                        <span className="rounded-full bg-[#FEF4EB] px-2 py-0.5 text-xs font-bold text-[#FFD77A]">Cancels at period end</span>
                      )}
                    </p>
                    {billingPlan?.plan === "plus" && billingPlan.current_period_end && (
                      <p className="mt-1 text-sm font-semibold text-[#59658d]">
                        {billingPlan.cancel_at_period_end ? "Access until" : "Renews on"}{" "}
                        {sgDay(billingPlan.current_period_end)}
                      </p>
                    )}
                  </div>
                  {billingPlan?.plan === "plus" ? (
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

              <DeleteAccountPanel isPlus={isPlus} />
            </div>
          )}
        </section>
      </main>
      <Footer />
    </PageShell>
  );
}

/** Settings → Delete account. Typing DELETE is the confirmation; the route
 *  cancels any live Plus subscription before removing the account. */
function DeleteAccountPanel({ isPlus }: { isPlus: boolean }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
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

  return (
    <div className="mt-4 rounded-[14px] border border-[#FED7E4] bg-white p-6 shadow-card">
      <h2 className="font-black text-[#FFC1D6]">Delete your account</h2>
      <p className="mt-1 text-sm font-semibold text-[#59658d]">
        This removes your profile, your children's details, preferences and saved activities.
        {isPlus ? " Your Plus subscription is cancelled at the same time, so you won't be charged again." : ""}
        {" "}It can't be undone.
      </p>

      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mt-4 rounded-[11px] border border-[#FED7E4] px-5 py-2.5 text-sm font-extrabold text-[#FFC1D6] hover:bg-[#FFF5F8]"
        >
          Delete account
        </button>
      ) : (
        <div className="mt-4 rounded-[12px] bg-[#FFF5F8] p-4">
          {/* The input is `block` so it sits under the instruction rather than
              running on beside it, and lines up with the buttons below. */}
          <label htmlFor="delete-confirm" className="block text-sm font-black text-[#FFC1D6]">
            Type DELETE to confirm
          </label>
          <input
            id="delete-confirm"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="mt-2 block h-11 w-full max-w-[220px] rounded-[10px] border border-[#FED7E4] px-3 text-sm font-semibold"
            placeholder="DELETE"
          />
          {error && <p className="mt-3 text-sm font-bold text-[#FFC1D6]">{error}</p>}
          <div className="mt-4 flex flex-wrap gap-3">
            <button
              type="button"
              disabled={confirm !== "DELETE" || busy}
              onClick={remove}
              className={`rounded-[11px] px-5 py-2.5 text-sm font-extrabold text-white ${
                confirm === "DELETE" && !busy ? "bg-[#FFC1D6] hover:brightness-105" : "cursor-not-allowed bg-[#FFC1D6]"
              }`}
            >
              {busy ? "Deleting…" : "Permanently delete"}
            </button>
            <Button type="button" variant="outline" onClick={() => { setOpen(false); setConfirm(""); setError(null); }}>
              Keep my account
            </Button>
          </div>
        </div>
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
          <img src={b.image} alt="" width={56} height={56} loading="lazy" decoding="async" className="h-14 w-14 flex-shrink-0 rounded-[10px] object-cover" />
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
          <div key={b.id} className="rounded-[12px] border border-[#EBE3E5] bg-white p-3 shadow-card transition hover:border-baby-pink">
            {/* A removed activity's own detail page is gone (unpublished,
                slug renamed by unlinkWixActivities) — send those clicks to
                the activities list instead of a dead link. */}
            <a href={b.slug && !b.removed ? `/activity?slug=${b.slug}` : "/explore"} className="flex items-start gap-3 sm:items-center sm:gap-4">
              <img src={b.image} alt="" width={64} height={64} loading="lazy" decoding="async" className="h-14 w-14 flex-shrink-0 rounded-[10px] object-cover sm:h-16 sm:w-16" />
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

export function PaymentPage() {
  // Card details are collected on Stripe's hosted Checkout, never here. This
  // page just kicks off (or resumes) that secure flow for anyone landing on
  // /payment directly, then redirects.
  const { session, loading } = useAuth();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (loading) return;
    if (!session) {
      goTo("/login");
      return;
    }
    apiPost<{ url?: string }>("/api/customer/stripe/subscription", { billing: "monthly" })
      .then(({ url }) => {
        if (url) window.location.href = url;
        else setError("Could not start checkout — please try again.");
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Payments aren't available right now."));
  }, [session, loading]);

  return (
    <PageShell active="/pricing" auth="public">
      <main className="mx-auto max-w-[520px] px-6 py-24 text-center">
        <BrandStacked className="h-24" />
        {error ? (
          <>
            <h1 className="mt-6 text-2xl font-black">We couldn't start checkout</h1>
            <p className="mt-3 font-semibold text-[#68718f]">{error}</p>
            <Button href="/pricing" className="mt-6">Back to plans</Button>
          </>
        ) : (
          <>
            <h1 className="mt-6 text-2xl font-black">Taking you to secure checkout…</h1>
            <p className="mt-3 font-semibold text-[#68718f]">You'll be redirected to Stripe to start your Plus subscription.</p>
          </>
        )}
      </main>
    </PageShell>
  );
}

/** One selectable row in the booking flow's "Choose your package" step. */
/** A row in booking step 4 — name and price on the left, the action on the
 *  right, as in the design. Selecting the row drives the main CTA; pack rows
 *  additionally offer "Buy pack", which goes straight to Stripe. */
function PackageOption({
  selected,
  onSelect,
  title,
  price,
  badge,
  action,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  price: string;
  badge?: string;
  /** Shown on the right for packs you can buy outright. */
  action?: { label: string; onClick: () => void; busy?: boolean };
}) {
  return (
    <div
      onClick={onSelect}
      role="radio"
      aria-checked={selected}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={`flex cursor-pointer items-center gap-4 rounded-[12px] border-2 p-4 transition ${
        selected ? "border-[#A7D8F8] bg-[#EDF7FD]" : "border-[#DCD2D5] bg-white hover:border-[#A7D8F8]"
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-black">{title}</span>
          {badge && <span className="rounded-full bg-[#FEF2D7] px-2 py-0.5 text-[10px] font-bold text-[#FFD77A]">{badge}</span>}
        </div>
        <span className="mt-0.5 block text-sm font-semibold text-[#59658d]">{price}</span>
      </div>
      {action && (
        <Button
          type="button"
          variant="pink"
          size="sm"
          className={action.busy ? "shrink-0 opacity-60" : "shrink-0"}
          onClick={() => {
            onSelect();
            action.onClick();
          }}
        >
          {action.busy ? "…" : action.label}
        </Button>
      )}
    </div>
  );
}

export function BookingPage() {
  const { activity, sessions, courseSpan, eventSoldOut, loading } = useActivityDetail(getParam("slug"));
  const { session: auth, children: kids } = useAuth();
  const redeemToken = getParam("token");
  /* "A spot has opened up" emails deep-link here with the freed slot
     (migration 00083): /book?slug=…&session=<id>. Until that slot has been
     resolved the date/time defaults below hold off, so the parent lands on the
     session the email was about rather than whichever one happens to be first. */
  const wantSessionId = getParam("session");
  const [preselectPending, setPreselectPending] = useState(Boolean(wantSessionId));
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [dateKey, setDateKey] = useState<string | null>(null);
  const [count, setCount] = useState(1);
  // Optional names for the extra seats of a multi-child booking (00084);
  // index 0 = the 2nd child. Blank entries become "Guest child" on both the
  // parent card and the vendor roster, editable later from My Bookings.
  const [guestNames, setGuestNames] = useState<string[]>([]);
  const [childId, setChildId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  type CreditPurchase = {
    id: string; remaining: number; expires_at: string | null;
    activity_ids: string[] | null; allowed_weekday: number | null; allowed_start_time: string | null;
  };
  const [purchases, setPurchases] = useState<CreditPurchase[]>([]);
  const [packs, setPacks] = useState<{ id: string; name: string; credits: number; price_cents: number }[]>([]);
  // Step 4: "single" | "credit" | "pack:<id>"
  const [payWith, setPayWith] = useState<string>("single");
  // The provider's own consents / waivers / disclosures for this class, and
  // which of them the parent has ticked. QA: the vendor's "require medical
  // disclosure" switch changed nothing on the parent's side, and each vendor
  // wants their own bespoke paperwork accepted before a booking stands.
  const [policies, setPolicies] = useState<ProviderPolicy[]>([]);
  const [acceptedPolicies, setAcceptedPolicies] = useState<string[]>([]);
  const [medicalNote, setMedicalNote] = useState("");
  /* The vendor's bespoke information request (migration 00074) — e.g. an
     address when the class is hosted at the family's own condo. */
  const [infoResponse, setInfoResponse] = useState("");
  /* Sessions this parent already holds a live booking on, as
     `${session_id}:${child_id}`. Booking the same child onto the same class
     twice is allowed — a parent may well want two slots for a friend — so this
     only drives a confirmation step, never a block. */
  const [existingBookings, setExistingBookings] = useState<Set<string>>(new Set());
  const [dupPrompt, setDupPrompt] = useState<null | { childName: string; proceed: () => void }>(null);

  // A Wix Event–backed activity (wix_service_type='EVENT', see
  // 00070_wix_events_as_activities.sql) reuses this whole page — the only
  // difference is what's picked (a ticket type, not a date/time — there's
  // only ever one session, the event's own occurrence) and which endpoint
  // gets called to actually purchase it.
  const isEvent = activity?.wix_service_type === "EVENT";
  // A Wix COURSE is enrolled as one whole programme, not per session — the
  // parent still sees every occurrence in the picker, but booking any of
  // them enrols in the entire run (handled server-side in resolveWixSlot).
  // These give the run's span for the added "Runs …" line and the booking
  // confirmation / My Bookings date range.
  const isCourse = activity?.wix_service_type === "COURSE";
  // Non-cancellable once booked: always for Wix ticketed events and courses
  // (reserved inside Wix), and for any other activity where the provider has
  // turned the cancellation toggle off on the edit-activity card. Drives the
  // disclaimer on the last booking step below; the matching disabled cancel
  // button lives in BookingList (allowCancel / isEvent / isCourse).
  const nonCancellable = isEvent || isCourse || activity?.allow_cancellation === false;
  // 00099: cancellations ARE allowed, but the provider gives nothing back —
  // shown instead of (never alongside) the non-cancellable notice.
  const nonRefundableOnCancel =
    !nonCancellable && activity?.cancellation_refund_mode === "none";
  type EventTicketType = { id: string; name: string; price_cents: number; currency: string; is_free: boolean; limit_per_checkout: number | null; hidden: boolean; fee_type: string | null; fee_rate_percent: number | null; sold_out: boolean };
  const [ticketTypes, setTicketTypes] = useState<EventTicketType[]>([]);
  const [ticketTypeId, setTicketTypeId] = useState<string | null>(null);

  useEffect(() => {
    if (!activity?.provider_id) return;
    supabase
      .from("provider_policies")
      .select("id, title, body, document_url, required, activity_id")
      .eq("provider_id", activity.provider_id)
      .eq("active", true)
      .order("sort_order")
      .then(({ data }) => {
        const rows = (data ?? []) as unknown as ProviderPolicy[];
        // A policy is either provider-wide (no activity) or pinned to this class.
        setPolicies(rows.filter((p) => !p.activity_id || p.activity_id === activity.id));
      });
  }, [activity?.provider_id, activity?.id]);

  // Packs this provider sells that apply to this class (or to all of theirs).
  useEffect(() => {
    if (!activity?.provider_id) return;
    supabase
      .from("packages")
      .select("id, name, credits, price_cents, activity_ids")
      .eq("provider_id", activity.provider_id)
      .eq("active", true)
      .then(({ data }) => {
        const rows = (data ?? []) as unknown as Array<{ id: string; name: string; credits: number; price_cents: number; activity_ids: string[] | null }>;
        setPacks(rows.filter((p) => !p.activity_ids || p.activity_ids.length === 0 || p.activity_ids.includes(activity.id)));
      });
  }, [activity?.provider_id, activity?.id]);

  // What this parent has already booked on this activity's sessions, so the
  // form can warn before putting the same child on the same class twice.
  useEffect(() => {
    if (!auth || !activity?.id) { setExistingBookings(new Set()); return; }
    supabase
      .from("bookings")
      .select("session_id, child_id, status, activity_sessions!inner(activity_id)")
      .eq("activity_sessions.activity_id", activity.id)
      .in("status", ["confirmed", "pending"])
      .then(({ data }) => {
        const rows = (data ?? []) as unknown as Array<{ session_id: string; child_id: string | null }>;
        setExistingBookings(new Set(rows.map((r) => `${r.session_id}:${r.child_id ?? ""}`)));
      });
  }, [auth, activity?.id]);

  useEffect(() => {
    if (!auth || !activity?.provider_id) return;
    supabase
      .from("package_purchases")
      .select("id, credits_remaining, expires_at, packages(activity_ids, allowed_weekday, allowed_start_time)")
      .eq("provider_id", activity.provider_id)
      .eq("status", "active")
      .gt("credits_remaining", 0)
      .order("created_at")
      .then(({ data }) => {
        const rows = (data ?? []) as unknown as Array<{
          id: string; credits_remaining: number; expires_at: string | null;
          packages: { activity_ids: string[] | null; allowed_weekday: number | null; allowed_start_time: string | null } | null;
        }>;
        setPurchases(
          rows
            .filter((r) => !r.expires_at || new Date(r.expires_at) > new Date())
            .map((r) => ({
              id: r.id,
              remaining: r.credits_remaining,
              expires_at: r.expires_at,
              activity_ids: r.packages?.activity_ids ?? null,
              allowed_weekday: r.packages?.allowed_weekday ?? null,
              allowed_start_time: r.packages?.allowed_start_time ?? null,
            }))
        );
      });
  }, [auth, activity?.provider_id]);

  // 1.2: a credit is only offered when the package's restrictions match the
  // chosen class and session slot (e.g. "Monday 4:00 pm only").
  function creditMatches(p: CreditPurchase, sess: ActivitySession | null) {
    if (p.activity_ids && p.activity_ids.length > 0 && !p.activity_ids.includes(activity?.id ?? "")) return false;
    if (!sess) return p.allowed_weekday == null && !p.allowed_start_time;
    const sg = new Date(sess.starts_at);
    const sgWeekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
      new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Singapore", weekday: "short" }).format(sg)
    );
    if (p.allowed_weekday != null && sgWeekday !== p.allowed_weekday) return false;
    if (p.allowed_start_time) {
      const t = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Singapore", hour: "2-digit", minute: "2-digit", hour12: false }).format(sg);
      if (t !== p.allowed_start_time.slice(0, 5)) return false;
    }
    return true;
  }
  const packageCredit = purchases.find((p) => creditMatches(p, selectedForCredit())) ?? null;
  const restrictedCredit = !packageCredit && purchases.length > 0 ? purchases[0] : null;
  function selectedForCredit() {
    return sessions.find((s) => s.id === sessionId) ?? null;
  }

  // Group upcoming sessions by date so the user picks a date, then a time.
  const byDate: Record<string, ActivitySession[]> = {};
  sessions.forEach((s) => {
    (byDate[sgDay(s.starts_at)] ||= []).push(s);
  });
  const dates = Object.keys(byDate);

  // Span of a course run. Wix's own schedule bounds (courseSpan) when we
  // have them — `sessions` is future-only, so deriving from it understates
  // the run for a course viewed mid-way — else first/last visible session.
  const courseStart =
    isCourse
      ? courseSpan?.start ??
        (sessions.length ? sessions.reduce((m, s) => (s.starts_at < m ? s.starts_at : m), sessions[0].starts_at) : null)
      : null;
  const courseEnd =
    isCourse
      ? courseSpan?.end ??
        (sessions.length
          ? sessions.reduce((m, s) => {
              const e = s.ends_at ?? s.starts_at;
              return e > m ? e : m;
            }, sessions[0].ends_at ?? sessions[0].starts_at)
          : null)
      : null;
  const courseRange = courseStart && courseEnd ? sgDayRange(courseStart, courseEnd) : null;
  // The course's distinct weekly strands (Wed vs Thu, each its own time) and
  // the course-wide spots-left figure — a course is booked as one unit, not
  // a chosen date/time.
  const strands = isCourse ? courseStrands(sessions) : [];
  const courseSpots = isCourse ? sessions[0]?.capacity ?? null : null;
  // Wix Events / Wix COURSEs have no BabyBrain waitlist (00107). "Sold out" =
  // an event whose every ticket type is gone, or a course with no dates left
  // (/api/wix/slots only returns occurrences that still have room). Blocks
  // the pay button and swaps the CTA copy; never set for native / Wix CLASS.
  const soldOut = isEvent ? eventSoldOut : isCourse ? sessions.length === 0 : false;

  useEffect(() => {
    if (!preselectPending || loading) return;
    // The slot may be gone by the time the parent opens the email — someone
    // else booked it, or the vendor pulled the session. Fall through to the
    // normal default rather than leaving the picker empty.
    const want = sessions.find((x) => x.id === wantSessionId);
    if (want) {
      setDateKey(sgDay(want.starts_at));
      setSessionId(want.id);
    }
    setPreselectPending(false);
  }, [preselectPending, loading, sessions, wantSessionId]);

  useEffect(() => {
    if (preselectPending) return;
    if (dates.length && !dateKey) setDateKey(dates[0]);
  }, [dates, dateKey, preselectPending]);

  // Events skip the date/time picker entirely — there's exactly one session
  // (materialized by lib/wix/events-sync.ts), so it's auto-selected the
  // moment it loads rather than making the parent click through a picker
  // with only one option in it.
  // Events and courses aren't date/time-picked — an event has one occurrence,
  // a course is enrolled as a whole — so auto-select the (any) underlying
  // session so the booking can proceed straight to child/payment.
  useEffect(() => {
    if ((isEvent || isCourse) && sessions.length > 0 && !sessionId) setSessionId(sessions[0].id);
  }, [isEvent, isCourse, sessions, sessionId]);

  useEffect(() => {
    if (!isEvent || !activity?.wix_event_id) { setTicketTypes([]); return; }
    supabase
      .from("event_ticket_types")
      .select("id, name, price_cents, currency, is_free, limit_per_checkout, hidden, fee_type, fee_rate_percent, sold_out")
      .eq("event_id", activity.wix_event_id)
      .eq("hidden", false)
      .order("price_cents")
      .then(({ data }) => setTicketTypes((data ?? []) as EventTicketType[]));
  }, [isEvent, activity?.wix_event_id]);

  useEffect(() => {
    if (ticketTypes.length === 0 || ticketTypeId) return;
    // Prefer a type that still has tickets; fall back to the first one so a
    // fully sold-out event still has something selected for the "sold out"
    // messaging to read from.
    setTicketTypeId((ticketTypes.find((t) => !t.sold_out) ?? ticketTypes[0]).id);
  }, [ticketTypes, ticketTypeId]);

  // Default to an available credit — it's the cheapest option for the parent.
  // Never for a Wix Event: it's ticketed through Wix, the "Select package"
  // step isn't even shown for one, and routing its checkout through the
  // package-credit path hits an RPC that can't take an event occurrence.
  useEffect(() => {
    // Events and courses are a single whole purchase — a multi-class pack
    // (one credit = one session) doesn't map onto them, so the "Select
    // package" step is hidden and payment stays "single".
    if (isEvent || isCourse) { if (payWith !== "single") setPayWith("single"); return; }
    if (packageCredit && payWith === "single") setPayWith("credit");
    else if (!packageCredit && payWith === "credit") setPayWith("single");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [packageCredit?.id, isEvent, isCourse]);

  const times = dateKey ? byDate[dateKey] ?? [] : [];
  const selected = sessions.find((s) => s.id === sessionId) ?? null;
  const bookChildId = childId ?? kids[0]?.id ?? null;
  const bookChild = kids.find((k) => k.id === bookChildId) ?? null;
  // Flag (not block outright) when the selected child falls outside the
  // class's stated age range — parents sometimes book ahead for a sibling or
  // a class that's a deliberate stretch, so this is a confirm-to-override
  // warning rather than a hard wall.
  const childAgeMonths = bookChild ? ageInMonths(bookChild.date_of_birth) : null;
  const childAgeMismatch =
    !!activity &&
    childAgeMonths != null &&
    (childAgeMonths < activity.age_min_months || childAgeMonths > activity.age_max_months);
  const selectedTicketType = isEvent ? ticketTypes.find((t) => t.id === ticketTypeId) ?? null : null;
  // Inclusive of Wix's own service fee where it applies (fee_rate_percent is
  // discovered once per ticket type by lib/wix/events-sync.ts and cached —
  // see ticketPriceWithFeeCents there) so this matches the real charge
  // instead of understating it; the actual amount is still always
  // recomputed server-side from a live Wix reservation
  // (computeWixCheckoutTotal in lib/wix/client.ts) at checkout time.
  const ticketPriceCents = (t: EventTicketType) =>
    t.fee_type === "FEE_ADDED_AT_CHECKOUT" && t.fee_rate_percent != null
      // Byte-for-byte the server's addTicketFeeCents (lib/wix/client.ts) — the
      // `price * (1 + rate/100)` form drifts by a floating-point ULP
      // (3500 * 1.025 → 3587.4999999999995, rounds to 3587) and undercut the
      // real Stripe charge by a cent.
      ? Math.round(t.price_cents + (t.price_cents * t.fee_rate_percent) / 100)
      : t.price_cents;
  /* A session can carry its own price, so the same class at two venues can
     cost different amounts (migration 00074). Session first, activity as the
     fallback — the same resolution the booking trigger and the checkout route
     use, so all three agree on what this booking costs. */
  const sessionPrice = selected?.price != null ? Number(selected.price) : null;

  /* The chosen session's own venue, when it differs from the activity's
     (migration 00074). Resolved lazily — most activities run at one venue, so
     there is nothing to look up. */
  const [sessionVenues, setSessionVenues] = useState<Record<string, string>>({});
  useEffect(() => {
    const ids = Array.from(new Set(sessions.map((x) => x.location_id).filter((v): v is string => !!v)));
    if (ids.length === 0) return;
    let cancelled = false;
    supabase
      .from("provider_locations")
      .select("id, name, address")
      .in("id", ids)
      .then(({ data }) => {
        if (cancelled) return;
        const next: Record<string, string> = {};
        for (const l of (data ?? []) as Array<{ id: string; name: string; address: string | null }>) {
          next[l.id] = [l.name, l.address].filter(Boolean).join(", ");
        }
        setSessionVenues(next);
      });
    return () => { cancelled = true; };
  }, [sessions]);
  const sessionVenueAddress = selected?.location_id ? sessionVenues[selected.location_id] ?? null : null;
  /* Where this booking actually happens: the chosen session's own venue once
     it has one (migration 00074), then the activity's own address, then the
     provider's — the last mirrors search_activities' coalesce(a.address,
     p.address), so an activity that deliberately carries no address of its
     own still shows its provider's here instead of a blank. Drives the
     on-page displays as well as the /booked redirect below. */
  const displayVenue =
    sessionVenueAddress ?? activity?.address ?? activity?.provider_contact?.address ?? null;
  /* QA 24/08: "I added a teacher and studio to an activity but it doesn't show
     anywhere on the parent side — it should show on the class option, booking
     confirmation screen and they should be able to see under bookings."
     Per-session, so it only reads once a slot is chosen. */
  const displayStaff = [selected?.teacher_name, selected?.studio].filter(Boolean).join(" · ") || null;
  const price = isEvent
    ? selectedTicketType != null ? ticketPriceCents(selectedTicketType) / 100 : null
    : sessionPrice != null ? sessionPrice
    : activity?.price != null ? Number(activity.price) : null;
  const total = price != null ? price * count : null;
  /* Sessions can carry their own venue and price (migration 00074), so the
     venue/price on this page can shift as the parent picks a different date
     or time. Flag it up front, but only for classes that actually have that
     variation — no point warning about a class that always runs at one
     venue for one price. */
  const slotDetailsVary =
    !isEvent &&
    sessions.length > 1 &&
    (new Set(sessions.map((s) => s.location_id ?? "_")).size > 1 ||
      new Set(sessions.map((s) => (s.price == null ? "_" : String(s.price)))).size > 1);
  const ticketQuantityCap = selectedTicketType?.limit_per_checkout && selectedTicketType.limit_per_checkout > 0
    ? Math.min(selectedTicketType.limit_per_checkout, 20)
    : 6;

  async function pay() {
    setErr(null);
    if (!auth) {
      goTo("/login");
      return;
    }
    if (!sessionId) {
      setErr(isEvent || isCourse ? "This isn't ready to book yet — try again shortly." : "Please choose a date and time first.");
      return;
    }
    if (isEvent && !ticketTypeId) {
      setErr("Please choose a ticket type first.");
      return;
    }
    // No BabyBrain waitlist for Wix Events / COURSEs (00107) — a stale click
    // on a sold-out event (or a sold-out ticket type within one) stops here
    // rather than 409-ing against Wix.
    if (soldOut || (isEvent && selectedTicketType?.sold_out)) {
      setErr(isEvent ? "This ticket is sold out." : "This course is currently full.");
      return;
    }
    // A ticketed Wix event has no free/comp path — the isEvent branch below
    // would ignore the token and send the parent to Stripe at full price
    // (which reads as a charge under a "this class is on the house" banner).
    // Block it with a clear message until event redemption actually exists.
    if (isEvent && redeemToken) {
      setErr("Make-up tokens can't be used for ticketed events yet. Contact the provider to arrange your place.");
      return;
    }
    setBusy(true);
    let status: string | null = null;
    if (isEvent) {
      // Wix Event ticket: a real reservation is made against Wix's own
      // inventory server-side (the authoritative availability check — there's
      // no local capacity to double-check against, see
      // app/api/wix/events/checkout). Free tickets confirm synchronously;
      // paid ones hand off to Stripe same as every other paid path here, and
      // the real Wix order isn't created until that payment is confirmed
      // (lib/wix/finalize-event-checkout.ts).
      const eventBody = {
        eventId: activity?.wix_event_id,
        ticketTypeId,
        quantity: count,
        childId: bookChildId,
        // The event form reuses the class booking form's "Provider terms"
        // section — the disclosure, the ticked waivers and the answer to the
        // vendor's info request all need to survive the trip to the roster.
        ...(medicalNote.trim() ? { medicalDisclosure: medicalNote.trim() } : {}),
        ...(acceptedPolicies.length ? { policiesAccepted: acceptedPolicies } : {}),
        ...(infoResponse.trim() ? { infoResponse: infoResponse.trim() } : {}),
      };
      if (selectedTicketType?.is_free) {
        try {
          const data = await apiPost<{ status: string }>("/api/wix/events/rsvp", eventBody);
          status = data.status;
        } catch (e) {
          setBusy(false);
          setErr(e instanceof Error ? e.message : "Could not reserve this ticket");
          return;
        }
        setBusy(false);
      } else {
        try {
          const { url } = await apiPost<{ url?: string }>("/api/wix/events/checkout", eventBody);
          if (url) {
            window.location.href = url;
            return;
          }
        } catch (e) {
          setBusy(false);
          setErr(e instanceof Error ? e.message : "Could not start payment");
          return;
        }
        setBusy(false);
        return;
      }
    } else if (redeemToken) {
      // Redeeming a make-up token: books the session and consumes the token atomically.
      if (sessionId.startsWith("wix:")) {
        // Wix-linked slot: no local activity_sessions row for the RPC to book
        // against, and the slot has to be reserved in Wix first — same split
        // as the package-credit path (/api/wix/bookings/redeem-package).
        try {
          const data = await apiPost<{ status: string }>("/api/wix/bookings/redeem-token", {
            activityId: activity?.id,
            wixSlotId: sessionId,
            tokenId: redeemToken,
            policiesAccepted: acceptedPolicies,
            ...(medicalNote.trim() ? { medicalDisclosure: medicalNote.trim() } : {}),
            ...(infoResponse.trim() ? { infoResponse: infoResponse.trim() } : {}),
          });
          status = data.status;
        } catch (e) {
          setBusy(false);
          setErr(e instanceof Error ? e.message : "Could not redeem this make-up token");
          return;
        }
        setBusy(false);
      } else {
        const { data, error } = await supabase.rpc("redeem_make_up_token", {
          p_token_id: redeemToken,
          p_session_id: sessionId,
          p_policies: acceptedPolicies,
          ...(medicalNote.trim() ? { p_medical: medicalNote.trim() } : {}),
          ...(infoResponse.trim() ? { p_info: infoResponse.trim() } : {}),
        });
        setBusy(false);
        if (error) {
          setErr(cleanRpcErrorMessage(error));
          return;
        }
        status = (data as string | null) ?? "confirmed";
      }
    } else if (sessionId.startsWith("wix:")) {
      // Wix-linked activity: the slot lives in Wix, not activity_sessions —
      // creating the booking there (and materializing the local session) is
      // handled server-side. Paid → hand off to Stripe Checkout same as a
      // native paid class; the real Wix reservation isn't made until the
      // webhook confirms payment (see /api/wix/bookings/checkout). Free
      // stays the direct, immediate booking it always was.
      const wixBody = {
        activityId: activity?.id,
        wixSlotId: sessionId,
        childId: bookChildId,
        policiesAccepted: acceptedPolicies,
        count,
        // Names for the extra seats (00084); blank -> "Guest child".
        ...(count > 1
          ? { guestNames: Array.from({ length: count - 1 }, (_, i) => (guestNames[i] ?? "").trim()) }
          : {}),
        ...(medicalNote.trim() ? { medicalDisclosure: medicalNote.trim() } : {}),
        // Required by the activity when info_request_enabled, and now
        // enforced server-side on both Wix endpoints — it used to be
        // collected on this page and then never sent, so the vendor's roster
        // showed the answer blank for every Wix-linked class.
        ...(infoResponse.trim() ? { infoResponse: infoResponse.trim() } : {}),
      };
      if (activity?.price != null && Number(activity.price) > 0) {
        try {
          const { url } = await apiPost<{ url?: string }>("/api/wix/bookings/checkout", wixBody);
          if (url) {
            window.location.href = url;
            return;
          }
        } catch (e) {
          setBusy(false);
          setErr(e instanceof Error ? e.message : "Could not start payment");
          return;
        }
        setBusy(false);
        return;
      }
      try {
        const data = await apiPost<{ id: string; status: string }>("/api/wix/bookings", wixBody);
        status = data.status;
      } catch (e) {
        setBusy(false);
        setErr(e instanceof Error ? e.message : "Could not create the booking");
        return;
      }
      setBusy(false);
    } else {
      // book_party (00084) inserts one bookings row per seat under a shared
      // booking_group_id. It takes the party as far as the session fits
      // (00104): overflow seats land on the waitlist and it returns 'pending'
      // as long as at least one seat needs paying. Seat 1 is the chosen child;
      // the rest carry the optional guest names.
      const guests =
        count > 1 ? Array.from({ length: count - 1 }, (_, i) => (guestNames[i] ?? "").trim()) : [];
      const { data, error } = await supabase
        .rpc("book_party", {
          p_session_id: sessionId,
          p_child_id: bookChildId,
          p_guest_names: guests,
          // Enforced again by the `booking_policy_gate` trigger, so a booking
          // can never exist without the provider's required consents.
          p_policies: acceptedPolicies,
          ...(medicalNote.trim() ? { p_medical: medicalNote.trim() } : {}),
          // Whatever the vendor asked for on this activity. The insert trigger
          // rejects a blank one when the request is switched on.
          ...(infoResponse.trim() ? { p_info: infoResponse.trim() } : {}),
        })
        .single();
      if (error || !data) {
        setBusy(false);
        setErr(error ? cleanRpcErrorMessage(error) : "Could not create the booking");
        return;
      }
      const { group_id: groupId, status: partyStatus } = data as { group_id: string | null; status: string };
      // Paid class → hand off to Stripe Checkout; the route charges only the
      // seats that fit and the webhook confirms just those. Free class stays
      // direct. 'waitlisted' means nothing fit — no payment, straight to the
      // waitlist confirmation.
      if (price != null && price > 0 && partyStatus !== "waitlisted") {
        try {
          const { url } = await apiPost<{ url?: string }>("/api/bookings/checkout", {
            group_id: groupId,
            session_id: sessionId,
          });
          if (url) {
            window.location.href = url;
            return;
          }
        } catch (e) {
          setBusy(false);
          setErr(e instanceof Error ? e.message : "Could not start payment");
          return;
        }
      }
      setBusy(false);
      status = partyStatus ?? "pending";
    }
    const q = new URLSearchParams({
      title: activity?.title ?? "your class",
      slug: activity?.slug ?? "",
      when: isCourse && courseRange ? courseRange : selected ? sgDateTime(selected.starts_at) : "",
      status: status ?? "pending",
      start: (isCourse ? courseStart : selected?.starts_at) ?? "",
      end: (isCourse ? courseEnd : selected?.ends_at) ?? "",
      // A session can sit at a different venue from its activity (00074), so
      // the address the parent is told to go to is the session's when it has one.
      venue: displayVenue ?? "",
      staff: displayStaff ?? "",
    });
    goTo(`/booked?${q.toString()}`);
  }

  async function payWithPackage() {
    if (!auth) { goTo("/login"); return; }
    if (!sessionId) { setErr("Please choose a date and time first."); return; }
    if (!packageCredit) return;
    // 1 child = 1 credit = 1 spot — count is how many are attending.
    if (packageCredit.remaining < count) {
      setErr(`This pack only has ${packageCredit.remaining} credit${packageCredit.remaining === 1 ? "" : "s"} left — not enough for ${count} children.`);
      return;
    }
    setBusy(true);
    let status: string;
    if (sessionId.startsWith("wix:")) {
      // Wix-linked activity: the slot lives in Wix, not activity_sessions —
      // redeem_package_credit expects a real session id, so this goes
      // through a route that creates the booking in Wix first (same as the
      // free-booking path) and only then redeems the credit.
      try {
        const data = await apiPost<{ status: string }>("/api/wix/bookings/redeem-package", {
          activityId: activity?.id,
          wixSlotId: sessionId,
          packagePurchaseId: packageCredit.id,
          childId: bookChildId,
          policiesAccepted: acceptedPolicies,
          count,
          ...(count > 1
            ? { guestNames: Array.from({ length: count - 1 }, (_, i) => (guestNames[i] ?? "").trim()) }
            : {}),
          ...(medicalNote.trim() ? { medicalDisclosure: medicalNote.trim() } : {}),
          ...(infoResponse.trim() ? { infoResponse: infoResponse.trim() } : {}),
        });
        status = data.status;
      } catch (e) {
        setBusy(false);
        setErr(e instanceof Error ? e.message : "Could not redeem this credit");
        return;
      }
    } else {
      const { data, error } = await supabase.rpc("redeem_package_credit", {
        p_purchase_id: packageCredit.id,
        p_session_id: sessionId,
        // Was hard-coded to null server-side, which is why a class booked with
        // a pack credit showed up as "Guest" on the vendor's roster.
        p_child_id: bookChildId,
        p_policies: acceptedPolicies,
        p_quantity: count,
        // Names for the extra seats (00084); blank -> "Guest child".
        ...(count > 1
          ? { p_guest_names: Array.from({ length: count - 1 }, (_, i) => (guestNames[i] ?? "").trim()) }
          : {}),
        ...(medicalNote.trim() ? { p_medical: medicalNote.trim() } : {}),
        ...(infoResponse.trim() ? { p_info: infoResponse.trim() } : {}),
      });
      if (error) { setBusy(false); setErr(cleanRpcErrorMessage(error)); return; }
      status = (data as string | null) ?? "confirmed";
    }
    setBusy(false);
    const q = new URLSearchParams({
      title: activity?.title ?? "your class",
      slug: activity?.slug ?? "",
      when: isCourse && courseRange ? courseRange : selected ? sgDateTime(selected.starts_at) : "",
      status,
      start: (isCourse ? courseStart : selected?.starts_at) ?? "",
      end: (isCourse ? courseEnd : selected?.ends_at) ?? "",
      // A session can sit at a different venue from its activity (00074), so
      // the address the parent is told to go to is the session's when it has one.
      venue: displayVenue ?? "",
      staff: displayStaff ?? "",
    });
    goTo(`/booked?${q.toString()}`);
  }

  /** Buy a multi-class pack, then come back here to book with a credit. */
  async function buyPack(packageId: string) {
    if (!auth) { goTo("/login"); return; }
    // Buying a pack books the selected class too, so the same paperwork applies.
    const consent = consentProblem();
    if (consent) { setErr(consent); return; }
    if (childAgeMismatch) {
      setErr(`${bookChild!.name} is ${formatChildAge(bookChild!.date_of_birth)}, outside this class's ${ageText} age range. Pick a different child, or a class suited to their age.`);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      // Passing the selected session/child means the webhook books this
      // class with the pack's first credit, not just grants it — QA: "buy a
      // package, that class should also then be booked".
      const { url } = await apiPost<{ url?: string }>("/api/customer/stripe/package", {
        package_id: packageId,
        ...(sessionId ? { activity_session_id: sessionId } : {}),
        ...(bookChildId ? { child_id: bookChildId } : {}),
      });
      if (url) window.location.href = url;
      else setErr("Could not start checkout — please try again.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not start checkout");
    } finally {
      setBusy(false);
    }
  }

  const requiredPolicies = policies.filter((p) => p.required);
  const missingPolicies = requiredPolicies.filter((p) => !acceptedPolicies.includes(p.id));
  const needsMedical = Boolean(activity?.requires_medical_disclosure);

  /** Everything the provider insists on before this booking can go through. */
  function consentProblem(): string | null {
    if (missingPolicies.length) {
      return `Please read and accept ${missingPolicies.map((p) => `"${p.title}"`).join(", ")} before booking.`;
    }
    if (needsMedical && !medicalNote.trim()) {
      return "This provider asks for a medical and health disclosure before the class — add it above (write \u201cnone\u201d if there is nothing to declare).";
    }
    if (activity?.info_request_enabled && !infoResponse.trim()) {
      return activity.info_request_prompt?.trim()
        ? `This provider needs an answer to: \u201c${activity.info_request_prompt.trim()}\u201d`
        : "This provider asks for some extra information before the class — add it above.";
    }
    return null;
  }

  /** True when this child already holds a live booking on the chosen session. */
  const alreadyBooked =
    !!sessionId && existingBookings.has(`${sessionId}:${bookChildId ?? ""}`);

  /** Route the CTA to whichever option was picked in step 4. */
  function checkout() {
    setErr(null);
    const consent = consentProblem();
    if (consent) {
      setErr(consent);
      return;
    }
    if (childAgeMismatch) {
      setErr(`${bookChild!.name} is ${formatChildAge(bookChild!.date_of_birth)}, outside this class's ${ageText} age range. Pick a different child, or a class suited to their age.`);
      return;
    }

    const go = () => {
      if (redeemToken) return pay();
      // A Wix Event is always bought as a ticket through Wix — package
      // credits and pack purchases don't apply, and redeem_package_credit
      // 400s on an event occurrence. Guard here too in case payWith is stale.
      if (isEvent) return pay();
      if (payWith === "credit") return payWithPackage();
      if (payWith.startsWith("pack:")) return buyPack(payWith.slice(5));
      return pay();
    };

    /* Booking the same child on the same session twice is deliberately still
       allowed — a parent may want a second slot for a friend — so this asks
       rather than blocks. QA 18/08. */
    if (alreadyBooked) {
      setDupPrompt({
        childName: bookChild?.name ?? "This child",
        proceed: () => { setDupPrompt(null); go(); },
      });
      return;
    }
    return go();
  }

  const selectedPack = payWith.startsWith("pack:") ? packs.find((p) => p.id === payWith.slice(5)) : undefined;
  const payLabel = !auth
    ? "Log in to book"
    : isEvent
      ? selectedTicketType?.is_free
        ? "Reserve free ticket"
        : total != null
          ? `Get ${count > 1 ? `${count} tickets` : "ticket"} — ${selectedTicketType?.currency ?? ""} ${total.toFixed(2)}`
          : "Get ticket"
      : redeemToken
        ? "Confirm with make-up token"
        : payWith === "credit"
          ? "Confirm with a package credit"
          : selectedPack
            ? `Buy pack — $${(selectedPack.price_cents / 100).toFixed(0)}`
            : total != null && total > 0
              ? `Pay $${total.toFixed(2)}`
              : "Confirm booking";

  if (loading) {
    return (
      <PageShell active="/book">
        <BookingPageSkeleton />
      </PageShell>
    );
  }
  if (!activity) {
    return (
      <PageShell active="/book">
        <main className="mx-auto max-w-[1024px] px-6 py-16 text-center font-bold text-[#5a6690]">
          Class not found. <a href="/explore" className="text-baby-pink">Browse activities →</a>
        </main>
      </PageShell>
    );
  }

  const img = activity.image_urls?.[0] ?? `${import.meta.env.BASE_URL}assets/crops/detail-hero.png`;
  const ageText = formatAgeRange(activity.age_min_months, activity.age_max_months);

  return (
    <PageShell active="/book">
      <main className="mx-auto max-w-[1024px] px-6 py-7">
        <div className="mb-6 flex gap-3 text-sm font-bold"><a href="/">Home</a><span>›</span><a href="/explore">Activities</a><span>›</span><a href={`/activity?slug=${activity.slug}`}>{activity.title}</a><span>›</span><span className="text-baby-pink">Book</span></div>
        <section className="rounded-[18px] border border-[#EBE3E5] bg-white shadow-card">
          <header className="grid items-center gap-5 border-b border-[#F4EFF0] p-6 md:grid-cols-[90px_1fr_240px]">
            <span className="grid h-20 w-20 place-items-center rounded-full bg-baby-pink text-white"><Icon name="calendar" className="h-10 w-10" /></span>
            <div><h1 className="text-[34px] font-black">{isEvent ? "Get your tickets" : "Book your class"}</h1><p className="text-lg font-semibold">{isEvent ? "Pick how many tickets you need, then check out." : "Choose your preferred date, time & package."}</p></div>
            {/* The brand icon itself, rather than the confetti mascot crop that
                was lifted from the design mockup. */}
            <img src={`${import.meta.env.BASE_URL}assets/brand/logo-icon.png`} alt="" className="hidden h-24 object-contain md:block" />
          </header>
          <div className="grid gap-5 p-6 lg:grid-cols-[1fr_340px]">
            <section>
              <div className="grid gap-5 md:grid-cols-[245px_1fr]">
                <img src={img} alt={activity.title} width={245} height={208} decoding="async" className="h-52 w-full rounded-[12px] object-cover" />
                <div>
                  <h2 className="text-xl font-black">{activity.title}</h2>
                  <p className="mt-2 font-semibold">{ageText}</p>
                  <div className="mt-5 space-y-3 font-semibold text-[#4a5685]">
                    {displayVenue && <p className="flex gap-2"><Icon name="pin" className="h-5 w-5 shrink-0 text-baby-lilac" /> {displayVenue}</p>}
                    {displayStaff && <p className="flex gap-2"><Icon name="user" className="h-5 w-5 shrink-0 text-baby-lilac" /> {displayStaff}</p>}
                    {activity.category_name && <p className="flex gap-2"><Icon name="music" className="h-5 w-5 text-baby-lilac" /> {activity.category_name}</p>}
                    <p className="flex gap-2"><Icon name="star" className="h-5 w-5 text-baby-lilac" /> {activity.rating_count > 0 ? `${Number(activity.rating_avg).toFixed(1)} (${activity.rating_count} reviews)` : "New class"}</p>
                  </div>
                </div>
              </div>

              <div className="mt-6 space-y-6 border-t border-[#F4EFF0] pt-5">
                {sessions.length === 0 ? (
                  <p className="rounded-[12px] bg-[#FFF5F8] p-4 font-semibold text-[#5a6690]">
                    {isCourse
                      ? "This course is currently full — no dates have spaces left. Check back soon, or try “Enquire Now” on the class page."
                      : "No upcoming sessions scheduled yet — try “Enquire Now” on the class page to ask the provider."}
                  </p>
                ) : (
                  <>
                    {isCourse && (
                      <section>
                        <h3 className="mb-4 text-xl font-black">1. Course schedule</h3>
                        <div className="rounded-[12px] border border-[#DCD2D5] bg-[#FAF7F7] p-4">
                          <p className="text-sm font-semibold text-[#5a6690]">
                            This is a course — one booking enrols your child for the whole run, every session below.
                          </p>
                          {courseRange && <p className="mt-1 text-sm font-black text-[#34406f]">Runs {courseRange}</p>}
                          <div className="mt-4 space-y-2">
                            {strands.map((st) => (
                              <div key={st.key} className="rounded-[10px] border border-[#EBE3E5] bg-white px-3 py-2.5">
                                <p className="text-sm font-black text-[#34406f]">{st.label}</p>
                                <p className="mt-0.5 text-xs font-semibold text-[#697390]">{st.range} · {st.count} {st.count === 1 ? "session" : "sessions"}</p>
                              </div>
                            ))}
                          </div>
                          {courseSpots != null && (
                            <p className="mt-3 text-xs font-semibold text-[#697390]">{courseSpots} {courseSpots === 1 ? "spot" : "spots"} left</p>
                          )}
                        </div>
                      </section>
                    )}
                    {!isEvent && !isCourse && (
                      <>
                        <section>
                          <h3 className="mb-4 text-xl font-black">1. Choose a date</h3>
                          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 md:grid-cols-5">
                            {/* Split "Tue, 25 Aug" into two fixed lines rather than
                                letting it wrap naturally — a plain text wrap broke
                                differently per weekday's width, so cards ended up
                                one or two lines tall depending on which day it was. */}
                            {dates.map((d) => {
                              const [weekday, dayMonth] = d.split(", ");
                              return (
                                <button key={d} onClick={() => { setDateKey(d); setSessionId(null); }} className={`rounded-[10px] border px-3 py-4 text-sm font-bold ${d === dateKey ? "border-baby-pink bg-[#FEEBF2] text-baby-cta" : "border-[#DCD2D5] bg-white"}`}>
                                  <span className="block whitespace-nowrap">{weekday},</span>
                                  <span className="block whitespace-nowrap">{dayMonth}</span>
                                  <span className="mt-2 block text-xs font-semibold text-[#697390]">{byDate[d].length} {byDate[d].length === 1 ? "time" : "times"}</span>
                                </button>
                              );
                            })}
                          </div>
                        </section>
                        <section>
                          <h3 className="mb-4 text-xl font-black">2. Choose a time</h3>
                          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 md:grid-cols-5">
                            {times.map((s) => (
                              <button key={s.id} onClick={() => setSessionId(s.id)} className={`rounded-[10px] border px-3 py-4 font-bold ${s.id === sessionId ? "border-baby-pink bg-[#FEEBF2] text-baby-cta" : "border-[#DCD2D5] bg-white"}`}>
                                <span className="block whitespace-nowrap">{sgTime(s.starts_at)}</span>
                                <span className="mt-2 block text-xs font-semibold text-[#697390]">{s.capacity != null ? `${s.capacity} spots` : "Available"}</span>
                              </button>
                            ))}
                          </div>
                          {slotDetailsVary && (
                            <p className="mt-4 flex items-start gap-2 rounded-[10px] bg-[#FEF2D7] px-4 py-2.5 text-sm font-bold text-yellow-600">
                              <Icon name="bell" className="mt-0.5 h-4 w-4 flex-shrink-0" />
                              This class runs at more than one venue or price — the date and time you pick may change the venue or price shown in your booking summary.
                            </p>
                          )}
                        </section>
                      </>
                    )}
                    {/* Events skip straight to a ticket-type picker — there's
                        only ever one occurrence (auto-selected above), so
                        "date/time" is nothing to choose. Only shown when
                        there's more than one type; a single type is
                        auto-selected silently. */}
                    {isEvent && ticketTypes.length > 1 && (
                      <section>
                        <h3 className="mb-4 text-xl font-black">Choose your ticket</h3>
                        <div className="space-y-3">
                          {ticketTypes.map((t) => (
                            <PackageOption
                              key={t.id}
                              selected={ticketTypeId === t.id}
                              onSelect={() => { if (!t.sold_out) setTicketTypeId(t.id); }}
                              title={t.name}
                              price={t.is_free ? "Free" : `${t.currency} ${(ticketPriceCents(t) / 100).toFixed(2)}`}
                              badge={t.sold_out ? "Sold out" : undefined}
                            />
                          ))}
                        </div>
                      </section>
                    )}
                    {kids.length > 1 && (
                      <section>
                        <h3 className="mb-4 text-xl font-black">Who's this class for?</h3>
                        <div className="flex flex-wrap gap-2">
                          {kids.map((k) => (
                            <button
                              key={k.id}
                              type="button"
                              onClick={() => setChildId(k.id)}
                              className={`flex items-center gap-2 rounded-[10px] border px-3 py-2 text-sm font-bold ${bookChildId === k.id ? "border-baby-pink bg-[#FEEBF2] text-baby-cta" : "border-[#DCD2D5] bg-white"}`}
                            >
                              <AnimalAvatar seed={k.avatar_seed ?? k.name} kind="child" gender={k.gender} className="h-6 w-6" /> {k.name}
                            </button>
                          ))}
                        </div>
                      </section>
                    )}
                    {childAgeMismatch && bookChild && (
                      <p className="flex items-start gap-2 rounded-[10px] bg-[#FEF2D7] px-4 py-2.5 text-sm font-bold text-yellow-600">
                        <Icon name="bell" className="mt-0.5 h-4 w-4 flex-shrink-0" />
                        {bookChild.name} is {formatChildAge(bookChild.date_of_birth)}, outside this class's {ageText} age range — you won't be able to confirm this booking with them selected.
                      </p>
                    )}
                    {alreadyBooked && !childAgeMismatch && (
                      <p className="flex items-start gap-2 rounded-[10px] bg-[#FEF2D7] px-4 py-2.5 text-sm font-bold text-yellow-600">
                        <Icon name="bell" className="mt-0.5 h-4 w-4 flex-shrink-0" />
                        {bookChild?.name ?? "This child"} is already booked on this session — you can book again if you need a second place, and we&rsquo;ll check first.
                      </p>
                    )}
                    <section>
                      <h3 className="mb-2 text-xl font-black">{isEvent ? "Number of tickets" : isCourse ? "2. Number of children" : "3. Number of children"}</h3>
                      <div className="inline-grid grid-cols-3 overflow-hidden rounded-[10px] border border-[#DCD2D5] text-xl font-black">
                        <button type="button" onClick={() => setCount((c) => Math.max(1, c - 1))} className="h-12 w-12">-</button>
                        <span className="grid h-12 w-14 place-items-center">{count}</span>
                        <button type="button" onClick={() => setCount((c) => Math.min(isEvent ? ticketQuantityCap : 6, c + 1))} className="h-12 w-12">+</button>
                      </div>
                    </section>
                    {!isEvent && !isCourse && count > 1 && (
                      <section>
                        <h3 className="mb-2 text-lg font-black">Names <span className="text-sm font-semibold text-[#59658d]">(optional)</span></h3>
                        <p className="mb-3 text-sm font-semibold text-[#59658d]">
                          {bookChild?.name ?? "Your child"} takes the first place. Name the other {count - 1 === 1 ? "child" : "children"} if you like — otherwise they show as &ldquo;Guest child&rdquo; to you and the provider. You can edit these later from My Bookings.
                        </p>
                        <div className="space-y-2">
                          {Array.from({ length: count - 1 }).map((_, i) => (
                            <input
                              key={i}
                              value={guestNames[i] ?? ""}
                              maxLength={80}
                              onChange={(e) => setGuestNames((xs) => { const n = [...xs]; n[i] = e.target.value; return n; })}
                              placeholder="Guest child"
                              className="w-full rounded-[10px] border border-[#FED7E4] px-3 py-2 text-sm font-semibold"
                            />
                          ))}
                        </div>
                      </section>
                    )}
                    {/* Step 4: how to pay for the class — a single drop-in, an
                        unused credit from a pack, or buying a pack now. Not
                        applicable to a Wix Event ticket — payment is always a
                        single purchase (see the isEvent branch in pay()). */}
                    {!redeemToken && !isEvent && !isCourse && (
                      <section>
                        <h3 className="mb-2 text-xl font-black">4. Select package</h3>
                        <p className="mb-4 text-sm font-semibold text-[#59658d]">Pay for this class on its own, or use a multi-class pack.</p>
                        <div className="space-y-3">
                          <PackageOption
                            selected={payWith === "single"}
                            onSelect={() => setPayWith("single")}
                            title="Single class"
                            price={price != null ? `$${(price * count).toFixed(2)}` : "Price on enquiry"}
                          />
                          {packageCredit && (
                            <PackageOption
                              selected={payWith === "credit"}
                              onSelect={() => setPayWith("credit")}
                              title={
                                count > 1
                                  ? `Use ${count} package credits — ${packageCredit.remaining} left`
                                  : `Use a package credit — ${packageCredit.remaining} left`
                              }
                              price="No charge"
                            />
                          )}
                          {packs.map((p) => (
                            <PackageOption
                              key={p.id}
                              selected={payWith === `pack:${p.id}`}
                              onSelect={() => setPayWith(`pack:${p.id}`)}
                              title={p.name}
                              price={`$${(p.price_cents / 100).toFixed(0)}`}
                              badge={price != null && p.credits > 0 && p.price_cents / 100 / p.credits < price ? "Best value" : undefined}
                              action={{ label: "Buy pack", onClick: () => buyPack(p.id), busy: busy && payWith === `pack:${p.id}` }}
                            />
                          ))}
                        </div>
                        {restrictedCredit && !packageCredit && (
                          <p className="mt-3 rounded-[10px] bg-[#F4F0FA] p-3 text-xs font-bold text-[#C7B1E6]">
                            You have package credits with this provider, but they can't be used for this{" "}
                            {restrictedCredit.activity_ids && restrictedCredit.activity_ids.length > 0 && !restrictedCredit.activity_ids.includes(activity?.id ?? "") ? "class" : "session slot"} — check your package's designated class or weekly slot.
                          </p>
                        )}
                      </section>
                    )}

                    {/* The provider's own paperwork. Each vendor writes their
                        own consents, waivers and disclosures, so this section
                        only appears when they have some. */}
                    {(policies.length > 0 || needsMedical) && (
                      <section>
                        {/* Step number tracks how many steps came before:
                            class = date, time, children (+ package unless a
                            make-up token skips it); a course is one "Course
                            schedule" step + children, with no package step,
                            so its Provider terms is always step 3. */}
                        <h3 className="mb-2 text-xl font-black">{isEvent ? "" : `${(isCourse ? 3 : redeemToken ? 4 : 5)}. `}Provider terms</h3>
                        <p className="mb-4 text-sm font-semibold text-[#59658d]">
                          {activity?.provider_name?.trim() || "This provider"} asks you to read and accept the following before the class.
                        </p>
                        <div className="space-y-3">
                          {policies.map((p) => {
                            const on = acceptedPolicies.includes(p.id);
                            return (
                              <label
                                key={p.id}
                                className={`flex cursor-pointer gap-3 rounded-[12px] border-2 p-4 transition ${on ? "border-[#A7D8F8] bg-[#EDF7FD]" : "border-[#DCD2D5] bg-white hover:border-[#A7D8F8]"}`}
                              >
                                <input
                                  type="checkbox"
                                  checked={on}
                                  onChange={() =>
                                    setAcceptedPolicies((xs) => (on ? xs.filter((x) => x !== p.id) : [...xs, p.id]))
                                  }
                                  className="mt-1 h-4 w-4 shrink-0 accent-[#FA5D93]"
                                />
                                <span className="min-w-0">
                                  <span className="block font-black">
                                    {p.title}
                                    {p.required ? <span className="ml-1 text-baby-pink">*</span> : (
                                      <span className="ml-2 rounded-full bg-[#F4EFF0] px-2 py-0.5 text-[10px] font-bold text-[#6D748D]">Optional</span>
                                    )}
                                  </span>
                                  {p.body && (
                                    <span className="mt-1 block whitespace-pre-wrap text-sm font-semibold leading-6 text-[#4a5685]">{p.body}</span>
                                  )}
                                  {p.document_url && (
                                    <a
                                      href={p.document_url}
                                      target="_blank"
                                      rel="noreferrer"
                                      onClick={(e) => e.stopPropagation()}
                                      className="mt-1 inline-flex items-center gap-1 text-sm font-black text-palette-blue underline"
                                    >
                                      <Icon name="open" className="h-3.5 w-3.5" /> Read the full document
                                    </a>
                                  )}
                                </span>
                              </label>
                            );
                          })}
                          {/* Whatever this vendor asks for on this activity —
                              an address when they host at your condo, say.
                              The wording is theirs (migration 00074). */}
                          {activity?.info_request_enabled && (
                            <div className="rounded-[12px] border-2 border-[#DCD2D5] bg-white p-4">
                              <p className="font-black">
                                {activity.info_request_prompt?.trim() || "The provider needs some extra information"}{" "}
                                <span className="text-baby-pink">*</span>
                              </p>
                              <textarea
                                value={infoResponse}
                                onChange={(e) => setInfoResponse(e.target.value)}
                                rows={3}
                                className="mt-2 w-full rounded-[10px] border border-[#FED7E4] px-3 py-2 text-sm font-semibold"
                                placeholder="Your answer"
                              />
                            </div>
                          )}
                          {needsMedical && (
                            <div className="rounded-[12px] border-2 border-[#DCD2D5] bg-white p-4">
                              <p className="font-black">Medical &amp; health disclosure <span className="text-baby-pink">*</span></p>
                              <p className="mt-1 text-sm font-semibold text-[#59658d]">
                                Anything the provider should know — allergies, conditions, medication. Write &ldquo;none&rdquo; if there is nothing to declare.
                              </p>
                              <textarea
                                value={medicalNote}
                                onChange={(e) => setMedicalNote(e.target.value)}
                                rows={3}
                                className="mt-2 w-full rounded-[10px] border border-[#FED7E4] px-3 py-2 text-sm font-semibold"
                                placeholder="e.g. mild peanut allergy — carries an EpiPen"
                              />
                            </div>
                          )}
                        </div>
                      </section>
                    )}
                  </>
                )}
              </div>
            </section>

            <aside className="rounded-[16px] border border-[#EBE3E5] bg-white p-5 shadow-card">
              <h2 className="text-xl font-black">Booking summary</h2>
              <div className="mt-5 flex gap-4">
                <img src={img} alt="" width={112} height={96} loading="lazy" decoding="async" className="h-24 w-28 rounded-[10px] object-cover" />
                <div><h3 className="font-black">{activity.title}</h3><p className="mt-1 text-sm font-semibold">{ageText}</p>{activity.category_name && <span className="mt-2 inline-block rounded-full bg-[#FEEBF2] px-3 py-1 text-xs font-bold text-baby-cta">{activity.category_name}</span>}</div>
              </div>
              <div className="mt-5 space-y-4 font-semibold text-[#3f4b78]">
                <p className="flex gap-2"><Icon name="calendar" className="h-5 w-5 shrink-0 text-baby-lilac" /> {selected ? sgDateTime(selected.starts_at) : "Select a date & time"}</p>
                {displayVenue && <p className="flex gap-2"><Icon name="pin" className="h-5 w-5 shrink-0 text-baby-lilac" /> {displayVenue}</p>}
                <p className="flex gap-2"><Icon name="user" className="h-5 w-5 shrink-0 text-baby-lilac" /> {count} {count === 1 ? "child" : "children"}, {ageText}</p>
              </div>
              <div className="my-5 border-t border-[#F4EFF0]" />
              <p className="flex justify-between text-lg font-black"><span>Total</span><span className="text-baby-pink">{redeemToken ? "$0.00" : total != null ? `$${total.toFixed(2)}` : "Price on enquiry"}</span></p>
            </aside>
          </div>
        </section>
        <section className="mt-5 grid items-center gap-5 rounded-[16px] border border-[#EBE3E5] bg-white p-6 shadow-card md:grid-cols-[1fr_360px]">
          <div>
            <div className="flex items-center gap-5"><span className="grid h-16 w-16 place-items-center rounded-full bg-[#FEEBF2] text-baby-cta"><Icon name="lock" className="h-8 w-8" /></span><p><span className="block font-bold">Total amount</span><strong className="text-3xl">{redeemToken ? "$0.00" : total != null ? `$${total.toFixed(2)}` : "—"}</strong></p></div>
            {err && <p className="mt-3 text-sm font-bold text-baby-pink">{err}</p>}
          </div>
          {redeemToken && (
            <p className="mb-3 rounded-[10px] bg-[#FEF2D7] px-4 py-2.5 text-sm font-bold text-[#FFD77A]"><Icon name="gift" className="mr-1 inline h-4 w-4" /> Using a make-up token — this class is on the house.</p>
          )}
          {activity?.bookings_paused ? (
            /* 1.1: the vendor has paused bookings for this class */
            <div className="rounded-[12px] bg-amber-50 p-4 text-center font-bold text-palette-yellow">
              <Icon name="bell" className="mr-2 inline h-5 w-5" /> Bookings for this class are temporarily paused by the provider. Please check back later or enquire with them directly.
            </div>
          ) : soldOut ? (
            /* Wix Event / Wix COURSE with nothing left to book — no waitlist
               here (00107), so the parent is told plainly rather than sent
               into a checkout that would fail against Wix. */
            <div className="rounded-[12px] bg-[#FAF7F7] p-4 text-center font-bold text-[#6D7486]">
              <Icon name="calendar" className="mr-2 inline h-5 w-5" />
              {isEvent
                ? "This event is sold out."
                : "This course is currently full — check back soon, or use “Enquire Now” on the class page."}
            </div>
          ) : (
            <Button type="button" size="lg" onClick={checkout} className={busy || !sessionId ? "opacity-60" : ""}>
              <Icon name="lock" className="h-5 w-5" /> {busy ? "Confirming…" : payLabel}
            </Button>
          )}
          {/* One grid item so the section's gap-5 sits above this block, not
              between the two lines — they hug each other instead. */}
          {(nonCancellable || nonRefundableOnCancel || (total != null && total > 0 && !redeemToken)) && (
            <div className="space-y-0.5 text-center md:col-span-2">
              {nonCancellable && (
                <p className="text-xs font-bold text-[#6D748D]">* This activity is non-cancellable once booked.</p>
              )}
              {nonRefundableOnCancel && (
                <p className="text-xs font-bold text-[#6D748D]">* Payment for this activity is non-refundable, if cancelled.</p>
              )}
              {total != null && total > 0 && !redeemToken && (
                <p className="text-xs font-semibold text-[#6D748D]">Secure and encrypted payment via Stripe</p>
              )}
            </div>
          )}
        </section>
      </main>
      {dupPrompt && (
        <ConfirmDialog
          title="Already booked on this class"
          copy={`${dupPrompt.childName} already has a place on this session. Book a second place anyway?`}
          confirmLabel="Yes, book again"
          cancelLabel="Cancel"
          onConfirm={dupPrompt.proceed}
          onClose={() => setDupPrompt(null)}
        />
      )}
      <Footer />
    </PageShell>
  );
}
