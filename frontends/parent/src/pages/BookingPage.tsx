import { useEffect, useRef, useState } from "react";
import { staffLabel } from "../lib/staffLabel";
import {
  ActivityCard,
  AnimalAvatar,
  Button,
  ConfirmDialog,
  Footer,
  Icon,
  PageShell,
  useThumb,
} from "../components/ui";
import { resolveActivityImage, FALLBACK_LOGO_URL } from "../lib/activityMedia";
import { BookingPageSkeleton } from "../components/Skeletons";
import { useAuth } from "../auth/AuthProvider";
import { supabase } from "../lib/supabase";
import { cacheFetch, cacheInvalidate } from "../lib/queryCache";
import { apiPost } from "../lib/api";
import { cleanRpcErrorMessage } from "../lib/errors";
import { goTo, getParam } from "../lib/nav";
import { sgDateTime, sgDay, sgTime, sgDayRange, courseStrands } from "../lib/schedule";
import { useActivityDetail, isPackOnSale } from "../lib/data";
import { formatChildAge, formatAgeRange, ageInMonths } from "../lib/database.types";
import type { ActivitySession, ProviderPolicy } from "../lib/database.types";

/** How long a pack's credits stay valid once bought — shown as the info icon's
 *  tooltip in booking step 5, before the parent commits to buying. The vendor
 *  sets one or the other, never both; checked in the same order as the
 *  vendor portal's own PackagesPage.tsx summary. */
function packValidityText(p: { validity_days: number | null; expiry_date: string | null }) {
  if (p.validity_days) return `Credits valid for ${p.validity_days} day${p.validity_days === 1 ? "" : "s"} after purchase`;
  if (p.expiry_date) return `Credits valid until ${sgDay(p.expiry_date)}`;
  return undefined;
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
  infoTooltip,
  action,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  price: string;
  badge?: string;
  /** Shown as a hover/tap info icon beside the title — e.g. how long the pack's credits stay valid once bought. */
  infoTooltip?: string;
  /** Shown on the right for packs you can buy outright. */
  action?: { label: string; onClick: () => void };
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
          {infoTooltip && (
            <svg
              onClick={(e) => e.stopPropagation()}
              aria-label={infoTooltip}
              role="img"
              className="h-3.5 w-3.5 flex-shrink-0 text-[#9AA2BD]"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <title>{infoTooltip}</title>
              <circle cx="12" cy="12" r="9" />
              <path d="M12 11v5.5M12 8v.01" />
            </svg>
          )}
        </div>
        <span className="mt-0.5 block text-sm font-semibold text-[#59658d]">{price}</span>
      </div>
      {action && (
        selected ? (
          // Once picked, this isn't really a call to action any more — the
          // row's own blue border/tint already says "this one's chosen", so
          // the button steps back to match instead of staying the same loud
          // pink CTA as "Select" (QA: the two read as identical at a glance).
          // Same footprint as the button below (border, size="sm" padding),
          // so nothing shifts when it flips from one state to the other.
          <span
            className="inline-flex shrink-0 items-center gap-1.5 rounded-[11px] border border-palette-blue bg-white px-4 py-2.5 text-[13px] font-extrabold text-palette-blueInk"
          >
            <Icon name="check" className="h-3.5 w-3.5" strokeWidth={3} /> Selected
          </span>
        ) : (
          <Button
            type="button"
            variant="pink"
            size="sm"
            className="shrink-0"
            onClick={action.onClick}
          >
            {action.label}
          </Button>
        )
      )}
    </div>
  );
}

export default function BookingPage() {
  const { activity, sessions, courseSpan, eventSoldOut, loading, sessionsLoading } = useActivityDetail(getParam("slug"));
  // Same guaranteed-something-renders fallback as ActivityCard/ActivityRow —
  // two independent requests (different Wix thumbnail sizes), so each gets
  // its own broken-image state. Hooks, so they have to run unconditionally —
  // ahead of the loading/not-found early returns below, not after them
  // (a build-breaking rules-of-hooks violation caught by ESLint, not tsc,
  // which is how it shipped and kept shipping across several commits: no one
  // ran the actual `npm run build` locally, only `tsc --noEmit`).
  const img = activity ? resolveActivityImage(activity, activity.provider_contact) ?? FALLBACK_LOGO_URL : FALLBACK_LOGO_URL;
  const heroImg = useThumb(img, 490, 416);
  const summaryImg = useThumb(img, 224, 192);
  const { session: auth, children: kids } = useAuth();
  const redeemToken = getParam("token");
  /* "A spot has opened up" emails deep-link here with the freed slot
     (migration 00083): /book?slug=…&session=<id>. Until that slot has been
     resolved the date/time defaults below hold off, so the parent lands on the
     session the email was about rather than whichever one happens to be first. */
  const wantSessionId = getParam("session");
  // The Activity page's own "Select" pack button (App.tsx) carries the pack
  // here as ?pack=<id> rather than buying it directly — this page is the
  // only place a pack purchase can actually go through, since it's the only
  // place a slot + Provider terms can be gathered first.
  const wantPackId = getParam("pack");
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
  const errRef = useRef<HTMLDivElement | null>(null);
  // Whatever's missing (slot, terms, ...) is easy to miss if the parent has
  // scrolled away from the Pay button — bring the message to them instead.
  useEffect(() => {
    if (err) errRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [err]);
  type CreditPurchase = {
    id: string; name: string; remaining: number; expires_at: string | null;
    activity_ids: string[] | null; allowed_weekday: number | null; allowed_start_time: string | null;
  };
  const [purchases, setPurchases] = useState<CreditPurchase[]>([]);
  // When 2+ purchases are simultaneously eligible for this session (e.g. a
  // broad "any class" pack alongside an activity-restricted one), the parent
  // picks which to spend from; null defers to the oldest eligible one.
  const [selectedCreditId, setSelectedCreditId] = useState<string | null>(null);
  const [packs, setPacks] = useState<{ id: string; name: string; credits: number; price_cents: number; best_value: boolean; validity_days: number | null; expiry_date: string | null }[]>([]);
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
      .select("id, title, body, document_url, required, activity_ids")
      .eq("provider_id", activity.provider_id)
      .eq("active", true)
      .order("sort_order")
      .then(({ data }) => {
        const rows = (data ?? []) as unknown as ProviderPolicy[];
        // A policy is provider-wide (no activities listed) or scoped to a set
        // of classes — keep it if this class is in that set.
        setPolicies(
          rows.filter((p) => !p.activity_ids || p.activity_ids.length === 0 || p.activity_ids.includes(activity.id)),
        );
      });
  }, [activity?.provider_id, activity?.id]);

  // Packs this provider sells that apply to this class (or to all of theirs).
  useEffect(() => {
    if (!activity?.provider_id) return;
    const providerId = activity.provider_id;
    // Shared cache key with ActivityDetailPage's identical query (App.tsx) —
    // Explore → listing → Book for the same provider fires this once, not twice.
    cacheFetch(`provider-packages:${providerId}`, 300_000, () =>
      supabase
        .from("packages")
        .select("id, name, credits, price_cents, activity_ids, starts_at, available_until, best_value, validity_days, expiry_date")
        .eq("provider_id", providerId)
        .eq("active", true)
        .then(({ data }) => (data ?? []) as unknown as Array<{ id: string; name: string; credits: number; price_cents: number; activity_ids: string[] | null; starts_at: string | null; available_until: string | null; best_value: boolean; validity_days: number | null; expiry_date: string | null }>)
    ).then((rows) => {
      const applicable = rows
        .filter((p) => !p.activity_ids || p.activity_ids.length === 0 || p.activity_ids.includes(activity.id))
        .filter(isPackOnSale);
      setPacks(applicable);
      // Arrived here with a pack already picked on the Activity page —
      // preselect it the same way the party still needs its own date/time.
      if (wantPackId && applicable.some((p) => p.id === wantPackId)) {
        setPayWith(`pack:${wantPackId}`);
      }
    });
  }, [activity?.provider_id, activity?.id, wantPackId]);

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
      .select("id, credits_remaining, expires_at, packages(name, activity_ids, allowed_weekday, allowed_start_time)")
      .eq("provider_id", activity.provider_id)
      // RLS also lets a provider's own staff read every purchase for that
      // provider (for the vendor portal) — without this, a parent who's
      // *also* a vendor member sees other customers' packs here as if they
      // were their own, then hits "not enough credits" at redemption
      // because ownership is (rightly) enforced there, not here.
      .eq("user_id", auth.user.id)
      .eq("status", "active")
      .gt("credits_remaining", 0)
      .order("created_at")
      .then(({ data }) => {
        const rows = (data ?? []) as unknown as Array<{
          id: string; credits_remaining: number; expires_at: string | null;
          packages: { name: string; activity_ids: string[] | null; allowed_weekday: number | null; allowed_start_time: string | null } | null;
        }>;
        setPurchases(
          rows
            .filter((r) => !r.expires_at || new Date(r.expires_at) > new Date())
            .map((r) => ({
              id: r.id,
              name: r.packages?.name ?? "Package",
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
  const matchingCredits = purchases.filter((p) => creditMatches(p, selectedForCredit()));
  // Defaults to the oldest eligible purchase (first-in, first-spent) unless
  // the parent has explicitly picked a different one below; a stale pick
  // (no longer eligible after changing date/time) falls back the same way.
  const packageCredit = matchingCredits.find((p) => p.id === selectedCreditId) ?? matchingCredits[0] ?? null;
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
  const strands = isCourse ? courseStrands(sessions, courseStart) : [];
  // /api/wix/slots reports Wix's remainingCapacity as each occurrence's
  // capacity; a course is one enrolment for the whole run, so the tightest
  // occurrence is what limits the party.
  const courseSpots = isCourse
    ? sessions.reduce<number | null>((m, x) => (x.capacity == null ? m : m == null ? x.capacity : Math.min(m, x.capacity)), null)
    : null;
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
  const displayStaff = staffLabel(selected?.teacher_name, selected?.studio) || null;
  const price = isEvent
    ? selectedTicketType != null ? ticketPriceCents(selectedTicketType) / 100 : null
    : sessionPrice != null ? sessionPrice
    : activity?.price != null ? Number(activity.price) : null;
  const total = price != null ? price * count : null;
  /* "Best value" used to mean "cheaper per class than paying single-class
     price" — which tags *every* pack that clears that (usually low) bar, not
     the actual best one. A 5-session pack at $50/class and a 10-session pack
     at $45/class both read as "Best value" even though the 10-session is
     strictly better (QA). Only the pack(s) at the lowest per-class price
     among what's actually on offer get the auto badge now; ties (as in the
     screenshot — two packs at the same $50/class) still both show it,
     honestly, rather than picking one arbitrarily.
     A vendor can also pick this themselves per pack (packages.best_value,
     migration 00164) — e.g. to promote a mid-tier pack the maths wouldn't
     otherwise pick. Any manual pick for this provider wins outright and the
     auto-computed one steps aside entirely, so a vendor who marks one pack
     doesn't also see the "cheapest" one highlighted for a reason they never
     asked for. A provider who's never touched the new checkbox keeps
     today's auto behaviour unchanged. */
  const anyManualBestValue = packs.some((p) => p.best_value);
  const bestPackPerClassPrice =
    !anyManualBestValue && packs.length > 0
      ? Math.min(...packs.filter((p) => p.credits > 0).map((p) => p.price_cents / 100 / p.credits))
      : null;
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
  const maxChildren = isEvent ? ticketQuantityCap : isCourse && courseSpots != null ? Math.max(1, Math.min(6, courseSpots)) : 6;
  // Spots can drop while the page is open (the slots list refreshes) — never
  // leave the party larger than what's left.
  useEffect(() => { setCount((c) => Math.min(c, maxChildren)); }, [maxChildren]);

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
    // Seats from a multi-child party that didn't fit and stayed on the
    // waitlist (00136) — shown on /booked alongside a non-'waitlisted'
    // status instead of the whole party reading as waitlisted.
    let wl = 0;
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
          console.error(e);
          setErr("Could not reserve this ticket — please try again.");
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
          console.error(e);
          setErr("Could not start payment — please try again.");
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
          console.error(e);
          setErr("Could not redeem this make-up token — please try again.");
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
          console.error(e);
          setErr("Could not start payment — please try again.");
          return;
        }
        setBusy(false);
        return;
      }
      try {
        const data = await apiPost<{ id: string; status: string; waitlistedCount?: number }>("/api/wix/bookings", wixBody);
        status = data.status;
        wl = data.waitlistedCount ?? 0;
      } catch (e) {
        setBusy(false);
        console.error(e);
        setErr("Could not create the booking — please try again.");
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
      const { group_id: groupId, status: partyStatus, waitlisted_count: partyWaitlisted } =
        data as { group_id: string | null; status: string; waitlisted_count: number };
      // Paid class → hand off to Stripe Checkout; the route charges only the
      // seats that fit and the webhook confirms just those (and computes its
      // own leftover-waitlist count for the success page). Free class stays
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
          console.error(e);
          setErr("Could not start payment — please try again.");
          return;
        }
      }
      setBusy(false);
      status = partyStatus ?? "pending";
      wl = partyWaitlisted ?? 0;
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
      ...(status !== "waitlisted" && wl > 0 ? { wl: String(wl) } : {}),
    });
    // This path can have just redeemed a make-up token — don't leave the
    // Profile tab's cached token list showing it as still unredeemed.
    if (auth?.user?.id) cacheInvalidate(`profile:tokens:${auth.user.id}`);
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
    // Seats that didn't fit and landed on the waitlist while the rest of the
    // party got in on this same credit purchase (00136) — every credit is
    // still spent up front regardless, see redeem_package_credit.
    let wl = 0;
    if (sessionId.startsWith("wix:")) {
      // Wix-linked activity: the slot lives in Wix, not activity_sessions —
      // redeem_package_credit expects a real session id, so this goes
      // through a route that creates the booking in Wix first (same as the
      // free-booking path) and only then redeems the credit.
      try {
        const data = await apiPost<{ status: string; waitlistedCount?: number }>("/api/wix/bookings/redeem-package", {
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
        wl = data.waitlistedCount ?? 0;
      } catch (e) {
        setBusy(false);
        console.error(e);
        setErr("Could not redeem this credit — please try again.");
        return;
      }
    } else {
      const { data, error } = await supabase
        .rpc("redeem_package_credit", {
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
        })
        .single();
      if (error) { setBusy(false); setErr(cleanRpcErrorMessage(error)); return; }
      const redeemed = data as { status: string; waitlisted_count: number } | null;
      status = redeemed?.status ?? "confirmed";
      wl = redeemed?.waitlisted_count ?? 0;
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
      ...(status !== "waitlisted" && wl > 0 ? { wl: String(wl) } : {}),
    });
    // Just spent a package credit — don't leave the Profile tab's cached
    // packages list showing the pre-redemption remaining count.
    if (auth?.user?.id) cacheInvalidate(`profile:packages:${auth.user.id}`);
    goTo(`/booked?${q.toString()}`);
  }

  /** Buy a multi-class pack, then come back here to book with a credit. */
  async function buyPack(packageId: string) {
    if (!auth) { goTo("/login"); return; }
    // Reachable only via checkout() now (the row's own button just selects
    // the pack), which already requires sessionId via the CTA's disabled
    // state — this guard is defense in case that call path ever changes.
    if (!sessionId) { setErr("Please choose a date and time first."); return; }
    // Buying a pack books the selected class too, so the same paperwork applies.
    const consent = consentProblem();
    if (consent) { setErr(consent); return; }
    if (childAgeMismatch) {
      setErr(`${bookChild!.name} is ${formatChildAge(bookChild!.date_of_birth)}, outside this class's ${ageText} age range. Pick a different child, or a class suited to their age.`);
      return;
    }
    const pack = packs.find((p) => p.id === packageId);
    // 1 child = 1 credit = 1 spot — the pack must cover the whole party, or
    // buying it would leave some children unbooked with no way to tell
    // which. Same shape as payWithPackage()'s existing check.
    if (pack && pack.credits < count) {
      setErr(`This pack only has ${pack.credits} credit${pack.credits === 1 ? "" : "s"} — not enough for ${count} children. Reduce the number of children or pick a pack with more credits.`);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      // Passing the selected session/child/party means the webhook books
      // this class (for the whole party, spending one credit per seat) with
      // the pack's own credits, not just grants them — QA: "buy a package,
      // that class should also then be booked".
      const { url } = await apiPost<{ url?: string }>("/api/customer/stripe/package", {
        package_id: packageId,
        activity_session_id: sessionId,
        ...(bookChildId ? { child_id: bookChildId } : {}),
        quantity: count,
        ...(count > 1
          ? { guest_names: Array.from({ length: count - 1 }, (_, i) => (guestNames[i] ?? "").trim()) }
          : {}),
        policies_accepted: acceptedPolicies,
        ...(medicalNote.trim() ? { medical_disclosure: medicalNote.trim() } : {}),
        ...(infoResponse.trim() ? { info_response: infoResponse.trim() } : {}),
      });
      if (url) window.location.href = url;
      else setErr("Could not start checkout — please try again.");
    } catch (e) {
      console.error(e);
      setErr("Could not start checkout — please try again.");
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

  // Greys the Pay button out as a hint that something's still missing —
  // it stays tappable in that state (see the button below) so a tap
  // explains exactly what, rather than silently doing nothing.
  const bookingIncomplete = !sessionId || consentProblem() != null;

  /** True when this child already holds a live booking on the chosen session. */
  const alreadyBooked =
    !!sessionId && existingBookings.has(`${sessionId}:${bookChildId ?? ""}`);

  /** Route the CTA to whichever option was picked in step 4. */
  function checkout() {
    setErr(null);
    // The button is always clickable (see its comment above) so this is the
    // first thing a Pay tap with nothing chosen yet actually hits.
    if (!sessionId) {
      setErr(isEvent || isCourse ? "This isn't ready to book yet — try again shortly." : "Please choose a date and time first.");
      return;
    }
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
  // What the summary sidebar and the "Total amount" block actually show —
  // must track payLabel's own amount, not always the single-class price.
  // Buying a pack used to bypass this page entirely (a separate "Buy pack"
  // button, own immediate purchase), so nothing here ever needed to reflect
  // a pack's price; now that it goes through this same CTA, showing the
  // single-class total while the button says "Buy pack — $500" read as a
  // straight contradiction (QA).
  const displayTotal = redeemToken || payWith === "credit" ? 0 : selectedPack ? selectedPack.price_cents / 100 : total;

  // Unlike the activity-detail page, booking needs sessions to pick a
  // default date/time immediately — wait for both phases, same as this
  // hook's old single-gate behavior, rather than flashing "no sessions" here.
  if (loading || sessionsLoading) {
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
                <img src={heroImg.src} onError={heroImg.onError} alt={activity.title} width={245} height={208} decoding="async" className={`h-52 w-full rounded-[12px] bg-[#F3EDF0] object-contain${heroImg.isLogo ? " p-6" : ""}`} />
                <div>
                  <h2 className="text-xl font-black">{activity.title}</h2>
                  <p className="mt-2 font-semibold">{ageText}</p>
                  <div className="mt-5 space-y-3 font-semibold text-[#4a5685]">
                    {displayVenue && <p className="flex gap-2"><Icon name="pin" className="h-5 w-5 shrink-0 text-baby-lilac" /> {displayVenue}</p>}
                    {displayStaff && <p className="flex gap-2"><Icon name="user" className="h-5 w-5 shrink-0 text-baby-lilac" /> {displayStaff}</p>}
                    {activity.category_name && <p className="flex gap-2"><Icon name="music" className="h-5 w-5 text-baby-lilac" /> {[activity.category_name, activity.category_name_2].filter(Boolean).join(" · ")}</p>}
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
                                <p className="mt-0.5 text-xs font-semibold text-[#697390]">{st.range ? `${st.range} · ` : ""}{st.note}</p>
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
                      <h3 className="mb-2 text-xl font-black">{isEvent ? "Number of tickets" : isCourse ? "2. Number of children" : "3. Number of tickets/passes"}</h3>
                      <div className="inline-grid grid-cols-3 overflow-hidden rounded-[10px] border border-[#DCD2D5] text-xl font-black">
                        <button type="button" onClick={() => setCount((c) => Math.max(1, c - 1))} className="h-12 w-12">-</button>
                        <span className="grid h-12 w-14 place-items-center">{count}</span>
                        <button type="button" onClick={() => setCount((c) => Math.min(maxChildren, c + 1))} className="h-12 w-12">+</button>
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
                    {/* The provider's own paperwork. Each vendor writes their
                        own consents, waivers and disclosures, so this section
                        only appears when they have some. */}
                    {(policies.length > 0 || needsMedical) && (
                      <section>
                        {/* Step number tracks how many steps came before:
                            class = date, time, children; a course is one
                            "Course schedule" step + children, with no package
                            step, so its Provider terms is always step 3. The
                            package step (when present) comes after terms, not
                            before — see "5. Select package" below. */}
                        <h3 className="mb-2 text-xl font-black">{isEvent ? "" : `${isCourse ? 3 : 4}. `}Provider terms</h3>
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

                    {/* Step 5: how to pay for the class — a single drop-in, an
                        unused credit from a pack, or buying a pack now. Not
                        applicable to a Wix Event ticket — payment is always a
                        single purchase (see the isEvent branch in pay()).
                        Comes after Provider terms: buying (or using) a pack
                        books a real seat, so the same slot + terms gating the
                        main CTA already enforces for a single-class booking
                        must apply here too — see checkout()/buyPack(). */}
                    {!redeemToken && !isEvent && !isCourse && (
                      <section>
                        <h3 className="mb-2 text-xl font-black">5. Select package</h3>
                        <p className="mb-4 text-sm font-semibold text-[#59658d]">Pay for this class on its own, or use a multi-class pack.</p>
                        <div className="space-y-3">
                          <PackageOption
                            selected={payWith === "single"}
                            onSelect={() => setPayWith("single")}
                            title="Single class"
                            price={price != null ? `$${(price * count).toFixed(2)}` : "Price on enquiry"}
                          />
                          {packageCredit && matchingCredits.length === 1 && (
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
                          {/* 2+ purchases apply to this session (e.g. a broad
                              "any class" pack and an activity-restricted one)
                              — let the parent choose which to spend instead
                              of always silently taking the oldest. */}
                          {matchingCredits.length > 1 && matchingCredits.map((p) => (
                            <PackageOption
                              key={p.id}
                              selected={payWith === "credit" && packageCredit?.id === p.id}
                              onSelect={() => { setSelectedCreditId(p.id); setPayWith("credit"); }}
                              title={
                                count > 1
                                  ? `${p.name} — use ${count} credits (${p.remaining} left)`
                                  : `${p.name} — use a credit (${p.remaining} left)`
                              }
                              price="No charge"
                            />
                          ))}
                          {/* Picking a pack only selects it — the row's own
                              button now just mirrors that ("Select" /
                              "Selected"), it no longer buys anything by
                              itself (that used to bypass the main CTA's slot
                              + Provider terms gating entirely). The actual
                              purchase happens from the bottom "Buy pack — $X"
                              CTA via checkout() -> buyPack(), same gated path
                              as every other payWith option. Selecting a pack
                              always replaces whatever payWith held before, so
                              only one pack can ever be the thing about to be
                              bought — it does not limit how many *separate*
                              packages a parent may already own. */}
                          {packs.map((p) => (
                            <PackageOption
                              key={p.id}
                              selected={payWith === `pack:${p.id}`}
                              onSelect={() => setPayWith(`pack:${p.id}`)}
                              title={p.name}
                              price={`$${(p.price_cents / 100).toFixed(0)}`}
                              infoTooltip={packValidityText(p)}
                              badge={
                                anyManualBestValue
                                  ? p.best_value
                                    ? "Best value"
                                    : undefined
                                  : price != null &&
                                      p.credits > 0 &&
                                      p.price_cents / 100 / p.credits < price &&
                                      bestPackPerClassPrice != null &&
                                      Math.abs(p.price_cents / 100 / p.credits - bestPackPerClassPrice) < 0.005
                                    ? "Best value"
                                    : undefined
                              }
                              action={{ label: "Select", onClick: () => setPayWith(`pack:${p.id}`) }}
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
                  </>
                )}
              </div>
            </section>

            <aside className="rounded-[16px] border border-[#EBE3E5] bg-white p-5 shadow-card">
              <h2 className="text-xl font-black">Booking summary</h2>
              <div className="mt-5 flex gap-4">
                <img src={summaryImg.src} onError={summaryImg.onError} alt="" width={112} height={96} loading="lazy" decoding="async" className={`h-24 w-28 rounded-[10px] bg-[#F3EDF0] object-contain${summaryImg.isLogo ? " p-3" : ""}`} />
                <div><h3 className="font-black">{activity.title}</h3><p className="mt-1 text-sm font-semibold">{ageText}</p>{activity.category_name && <div className="mt-2 flex flex-wrap gap-1.5">{[activity.category_name, activity.category_name_2].filter((n): n is string => !!n).map((n) => <span key={n} className="inline-block rounded-full bg-[#FEEBF2] px-3 py-1 text-xs font-bold text-baby-cta">{n}</span>)}</div>}</div>
              </div>
              <div className="mt-5 space-y-4 font-semibold text-[#3f4b78]">
                <p className="flex gap-2"><Icon name="calendar" className="h-5 w-5 shrink-0 text-baby-lilac" /> {selected ? sgDateTime(selected.starts_at) : "Select a date & time"}</p>
                {displayVenue && <p className="flex gap-2"><Icon name="pin" className="h-5 w-5 shrink-0 text-baby-lilac" /> {displayVenue}</p>}
                <p className="flex gap-2"><Icon name="user" className="h-5 w-5 shrink-0 text-baby-lilac" /> {count} {count === 1 ? "child" : "children"}, {ageText}</p>
              </div>
              <div className="my-5 border-t border-[#F4EFF0]" />
              <p className="flex justify-between text-lg font-black"><span>Total</span><span className="text-baby-pink">{displayTotal != null ? `$${displayTotal.toFixed(2)}` : "Price on enquiry"}</span></p>
            </aside>
          </div>
        </section>
        <section className="mt-5 grid items-center gap-5 rounded-[16px] border border-[#EBE3E5] bg-white p-6 shadow-card md:grid-cols-[1fr_360px]">
          <div>
            <div className="flex items-center gap-5"><span className="grid h-16 w-16 place-items-center rounded-full bg-[#FEEBF2] text-baby-cta"><Icon name="lock" className="h-8 w-8" /></span><p><span className="block font-bold">Total amount</span><strong className="text-3xl">{displayTotal != null ? `$${displayTotal.toFixed(2)}` : "—"}</strong></p></div>
            {err && (
              <div ref={errRef} role="alert" className="mt-3 flex items-start gap-2 rounded-[10px] bg-palette-purpleSoft px-3.5 py-2.5 text-sm font-bold text-palette-purpleInk">
                <Icon name="bell" className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{err}</span>
              </div>
            )}
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
            // Greyed out (not `disabled`) while a slot or required terms are
            // still missing — a real `disabled` button swallows the tap
            // silently, which is exactly the "nothing happens when I hit Pay"
            // bug this guards against. It stays tappable in that dimmed state
            // so checkout() can surface a friendly message via the alert
            // above explaining what's left, instead of just sitting there.
            <Button type="button" size="lg" onClick={checkout} disabled={busy} className={busy || bookingIncomplete ? "opacity-60" : ""}>
              <Icon name="lock" className="h-5 w-5" /> {busy ? "Confirming…" : payLabel}
            </Button>
          )}
          {/* One grid item so the section's gap-5 sits above this block, not
              between the two lines — they hug each other instead. */}
          {(nonCancellable || nonRefundableOnCancel || (displayTotal != null && displayTotal > 0)) && (
            <div className="space-y-0.5 text-center md:col-span-2">
              {nonCancellable && (
                <p className="text-xs font-bold text-[#6D748D]">* This activity is non-cancellable once booked.</p>
              )}
              {nonRefundableOnCancel && (
                <p className="text-xs font-bold text-[#6D748D]">* Payment for this activity is non-refundable, if cancelled.</p>
              )}
              {displayTotal != null && displayTotal > 0 && (
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
