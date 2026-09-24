import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import { apiGet } from "./api";
import { getPlanCache, setPlanCache, clearPlanCache, type Plan } from "./planCache";
import { useAuth } from "../auth/AuthProvider";
import { useFavoritesStore } from "./favorites";
import { cacheGet, cacheSet, cacheInvalidate } from "./queryCache";
import { goTo } from "./nav";
import { resolveActivityImage, FALLBACK_LOGO_URL } from "./activityMedia";
import { isMultiDay, sgShortRange } from "./schedule";
import {
  formatAgeRange,
  type Activity as ActivityRow,
  type ActivitySession,
  type Review,
  type Child,
  type JourneyStats,
} from "./database.types";

/** Whether a vendor's package (credit pack) is currently on sale — has
 *  passed its scheduled `starts_at` ("Available from", if any) and hasn't
 *  reached its `available_until` ("Available until", if any). This is only
 *  about the sale window; expiry_date/validity_days are a separate,
 *  per-purchase concern (how long a parent's own credits stay valid once
 *  bought) and don't affect whether the pack is still listed. Mirrors the
 *  vendor portal's packStatus in PackagesPage.tsx; both must be kept in step
 *  with each other. */
export function isPackOnSale(p: { starts_at: string | null; available_until: string | null }) {
  const now = new Date();
  if (p.starts_at && new Date(p.starts_at) > now) return false;
  if (p.available_until && new Date(p.available_until) <= now) return false;
  return true;
}

/** The signed-in parent's plan. It can only be learned from the Stripe
 *  subscription route, which sits downstream of the whole auth cold-start — on
 *  a hard refresh that's 4-5s during which we'd otherwise assume `free` and
 *  render the locked/Upgrade view, then snap to Plus once it answers.
 *
 *  So the last known plan is cached (in memory + localStorage, see
 *  lib/planCache) and read back synchronously here: a returning parent renders
 *  their real plan on the first paint, and the route call just revalidates in
 *  the background. `known` is false only on a device that has never resolved a
 *  plan — callers hold gated UI neutral (not "free") until it flips. */
export function usePlan() {
  const { session, loading: authLoading } = useAuth();
  const userId = session?.user.id;
  const cached = getPlanCache(userId);
  const [plan, setPlan] = useState<Plan>(cached?.plan ?? "free");
  // We "know" the plan as soon as there's any cached/persisted value; without
  // one the first render is a guess, so callers keep gated UI neutral.
  const [known, setKnown] = useState(!!cached);
  const [loading, setLoading] = useState(!cached);

  useEffect(() => {
    if (authLoading) return;
    if (!session) {
      // Signed out — drop any cached plan so the next account on this browser
      // can't inherit it, and settle on the neutral default.
      clearPlanCache();
      setPlan("free");
      setKnown(true);
      setLoading(false);
      return;
    }
    // 60s is short enough that returning from Stripe shows the new plan.
    const fresh = getPlanCache(userId);
    if (fresh && Date.now() - fresh.at < 60_000) {
      setPlan(fresh.plan);
      setKnown(true);
      setLoading(false);
      return;
    }
    let cancelled = false;
    apiGet<{ plan: "free" | "plus" }>("/api/customer/stripe/subscription")
      .then((p) => {
        setPlanCache(userId, p.plan);
        if (!cancelled) setPlan(p.plan);
      })
      .catch(() => {})
      .finally(() => {
        // Either we have an answer or the lookup failed — stop holding gated
        // UI neutral. On failure this falls back to the `free`/persisted value
        // already in state, same as before.
        if (!cancelled) {
          setKnown(true);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [session, authLoading]);

  return { plan, isPlus: plan === "plus", loading, known };
}

/** Drop the cached plan after an upgrade/downgrade so the UI re-reads it. */
export function invalidatePlan() {
  clearPlanCache();
}

/** Record an authoritative plan learned elsewhere (e.g. the billing panel's
 *  fuller subscription fetch) so `usePlan` and the next hard refresh pick it
 *  up without waiting on another round-trip. Pass the signed-in user's id so
 *  the value is bound to their account. */
export function primePlan(userId: string | undefined, plan: Plan) {
  setPlanCache(userId, plan);
}

export interface ProviderContact {
  whatsapp: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  business_name: string | null;
  website: string | null;
  // The provider's own address, as the venue fallback for an activity that
  // deliberately carries none (it inherits — same as search_activities'
  // coalesce(a.address, p.address)).
  address: string | null;
  // Profile media/about — the fallback source for an activity with none of
  // its own (or explicitly set to borrow the provider's). See
  // activityMedia.ts / activity.image_source.
  description: string | null;
  logo_url: string | null;
  cover_image_url: string | null;
  gallery_urls: string[] | null;
}

/**
 * A locally-recorded session's upcoming rows, with `capacity` already turned
 * from the class's total into what's actually still open — "10 spots" used
 * to stay 10 even once 3 families had booked it.
 *
 * One `rpc` call, not the select-then-separately-fetch-booked-counts this
 * used to be (see git history / migration 00163's own comment): the second
 * leg only ever started once the first had returned, so it was pure added
 * latency on every single activity page view — found investigating a report
 * of native activity pages taking 10+ seconds even with no concurrent
 * traffic. `upcoming_activity_sessions` (migration 00163) does the same
 * eligibility filtering (no `wix_slot_key`, not paused, future, capped,
 * ordered) and the same booked-count subtraction
 * (`pending`/`confirmed`/`completed`, matching what
 * `/api/public/booked-counts` and `handle_booking_insert()` both count) in
 * one round trip.
 */
async function fetchUpcomingSessions(activityId: string, limit = 8): Promise<ActivitySession[]> {
  const { data } = await supabase.rpc("upcoming_activity_sessions", {
    p_activity_id: activityId,
    p_limit: limit,
  });
  return data ?? [];
}

export interface ActivityDetail {
  activity:
    | (ActivityRow & {
        category_name: string | null;
        category_name_2?: string | null;
        provider_contact: ProviderContact | null;
        // Messaging is a Growth-and-above perk — a Pay As You Grow provider
        // isn't reachable via chat, so the buttons grey out instead.
        provider_can_message: boolean;
      })
    | null;
  sessions: ActivitySession[];
  reviews: Review[];
  // A Wix COURSE's whole-run bounds from Wix's own schedule (see
  // /api/wix/slots). `sessions` is future-only, so this is what the "Runs …"
  // span uses to stay right for a course viewed mid-run.
  courseSpan: { start: string; end: string } | null;
  // Wix Event only: every non-hidden ticket type is sold out on Wix. Wix
  // Events have no BabyBrain waitlist (00107), so the booking UI shows a
  // disabled "Sold out" rather than "0 spots". Always false for non-events.
  eventSoldOut: boolean;
  loading: boolean;
}

const EMPTY_DETAIL: ActivityDetail = {
  activity: null,
  sessions: [],
  reviews: [],
  courseSpan: null,
  eventSoldOut: false,
  loading: true,
};

// A cache hit within this window skips the network entirely, same pattern as
// useActivities' FRESH_MS — this page's whole waterfall (activities join,
// then sessions + reviews + provider-plan) has no server/CDN cache layer of
// its own, so every mount used to re-run it regardless of how recently the
// same activity was already fetched. Short enough that "session capacity and
// reviews are worth re-fetching every time" (the concern the comment below
// is about) still holds for anything but back-to-back views seconds apart —
// e.g. bouncing from the listing to Explore and back.
const DETAIL_FRESH_MS = 20_000;

export function useActivityDetail(slug: string | null): ActivityDetail {
  const detailKey = slug ? "detail:" + slug : null;
  const seed = detailKey ? cacheGet<ActivityDetail>(detailKey) : undefined;
  const [state, setState] = useState<ActivityDetail>(
    seed ? { ...seed.data, loading: false } : EMPTY_DETAIL
  );

  useEffect(() => {
    if (!slug || !detailKey) {
      setState((s) => ({ ...s, loading: false }));
      return;
    }
    // Show the last-seen listing at once on a return visit, then refresh it in
    // place (session capacity and the review list are worth re-fetching every
    // time). Only fall back to the skeleton when there's nothing cached — e.g.
    // a client-side hop straight from one listing to another.
    const cached = cacheGet<ActivityDetail>(detailKey);
    if (cached) {
      setState({ ...cached.data, loading: false });
      if (cached.age < DETAIL_FRESH_MS) return; // fresh enough — no network at all
    } else {
      setState((s) => ({ ...s, loading: true }));
    }
    let cancelled = false;
    (async () => {
      // Only published listings. QA reached "Storytime Stretch: Kids Yoga" — an
      // unpublished mock row with no linked provider — by direct link, and it
      // rendered a listing page with none of the contact buttons.
      const { data: act } = await supabase
        .from("activities")
        .select("*, activity_categories!activities_category_id_fkey(name), category_2:activity_categories!activities_secondary_category_id_fkey(name), providers(whatsapp, contact_phone, contact_email, business_name, website, address, description, logo_url, cover_image_url, gallery_urls)")
        .eq("slug", slug)
        .eq("is_published", true)
        .maybeSingle();
      if (!act) {
        if (!cancelled) setState({ activity: null, sessions: [], reviews: [], courseSpan: null, eventSoldOut: false, loading: false });
        return;
      }

      // 2.3: count this view towards the vendor's conversion insights.
      if (act.provider_id) {
        supabase.auth.getUser().then(({ data: u }) =>
          supabase
            .from("listing_events")
            .insert({ provider_id: act.provider_id, activity_id: act.id, type: "listing_view", viewer_id: u.user?.id ?? null })
            .then(() => undefined)
        );
      }
      // A Wix-linked activity's availability comes from two places: slots
      // live from Wix, PLUS any independent (non-Wix) slots the vendor added
      // directly on BabyBrain for this same listing — those are ordinary
      // activity_sessions rows with no wix_slot_key (a Wix-materialized row
      // always has one, so this excludes it and avoids double-listing).
      // /api/wix/bookings materializes a session row only once a Wix slot is
      // actually booked.
      // A course's real run span comes back alongside its slots (Wix's own
      // schedule bounds) — captured here so the setState below can surface
      // it, since it isn't a per-session value.
      let wixCourseSpan: { start: string; end: string } | null = null;
      const sessionsPromise: Promise<ActivitySession[]> = act.wix_service_id
        ? Promise.all([
            apiGet<{ slots: { id: string; starts_at: string; ends_at: string; capacity: number }[]; course?: { start: string; end: string } | null }>(
              `/api/wix/slots?activityId=${act.id}`
            )
              .then((r) => {
                wixCourseSpan = r.course ?? null;
                return r.slots.map((s) => ({
                  id: s.id,
                  activity_id: act.id,
                  starts_at: s.starts_at,
                  ends_at: s.ends_at,
                  // 1 for an appointment; a class's real remaining capacity.
                  capacity: s.capacity,
                  location_id: null,
                  // A Wix slot's price comes from the Wix service, not from a
                  // BabyBrain per-session override, so it inherits.
                  price: null,
                  status: "scheduled" as const,
                  // Pausing is a BabyBrain per-session control (00084); a Wix
                  // slot's availability is Wix's to decide, so it's never
                  // paused on our side.
                  bookings_paused: false,
                  // Wix staffs its own slots; we hold no teacher/studio for one.
                  teacher_name: null,
                  studio: null,
                  wix_slot_key: null,
                  wix_remaining_capacity: null,
                  created_at: new Date().toISOString(),
                  // Not yet materialized as a real activity_sessions row, so
                  // there's nothing to override — inherits the activity's own
                  // policy, same as every other unmaterialized Wix slot.
                  allow_cancellation: null,
                  cancellation_cutoff_hours: null,
                  cancellation_refund_mode: null,
                  allow_rescheduling: null,
                  reschedule_cutoff_hours: null,
                  booking_cutoff_minutes: null,
                }));
              })
              .catch(() => []),
            // Filters (no wix_slot_key, not paused, future, capped, ordered)
            // and the booked-count subtraction both happen server-side now —
            // see fetchUpcomingSessions above.
            fetchUpcomingSessions(act.id),
          ]).then(([wixSlots, independentSlots]) =>
            [...wixSlots, ...independentSlots].sort(
              (a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime()
            )
          )
        : fetchUpcomingSessions(act.id);

      // Wix Event: does any bookable ticket remain? A type counts as sold out
      // when Wix says so (sold_out) or its unsold count has hit zero. Every
      // non-hidden type gone -> the event as a whole is sold out. Non-events
      // resolve `false` without a query.
      const eventSoldOutPromise: Promise<boolean> = act.wix_event_id
        ? Promise.resolve(
            supabase
              .from("event_ticket_types")
              .select("sold_out, capacity_remaining, hidden")
              .eq("event_id", act.wix_event_id)
              .eq("hidden", false)
          ).then(({ data }) => {
            const types = data ?? [];
            return (
              types.length > 0 &&
              types.every((t) => t.sold_out || t.capacity_remaining === 0)
            );
          })
        : Promise.resolve(false);

      const [sessions, { data: reviews }, providerCanMessage, eventSoldOut] = await Promise.all([
        sessionsPromise,
        supabase
          .from("reviews")
          .select("*")
          .eq("activity_id", act.id)
          .order("created_at", { ascending: false })
          .limit(10),
        act.provider_id
          ? apiGet<{ canMessage: boolean }>(`/api/public/provider-plan?providerId=${act.provider_id}`)
              .then((r) => r.canMessage)
              .catch(() => false)
          : Promise.resolve(false),
        eventSoldOutPromise,
      ]);
      const next: ActivityDetail = {
        activity: {
          ...act,
          category_name:
            (act.activity_categories as unknown as { name: string } | null)?.name ?? null,
          category_name_2:
            (act.category_2 as unknown as { name: string } | null)?.name ?? null,
          provider_contact: (act.providers as unknown as ProviderContact | null) ?? null,
          provider_can_message: providerCanMessage,
        },
        sessions,
        reviews: reviews ?? [],
        courseSpan: wixCourseSpan,
        eventSoldOut,
        loading: false,
      };
      cacheSet(detailKey, next);
      if (!cancelled) setState(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  return state;
}

/** Favourite-provider toggle for the signed-in parent. */
export function useFavoriteProvider(providerId: string | null | undefined) {
  const { session } = useAuth();
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!session || !providerId) return;
    supabase
      .from("favorite_providers")
      .select("provider_id")
      .eq("user_id", session.user.id)
      .eq("provider_id", providerId)
      .maybeSingle()
      .then(({ data }) => setSaved(Boolean(data)));
  }, [session, providerId]);

  async function toggle() {
    if (!providerId) return;
    if (!session) {
      goTo("/login");
      return;
    }
    setBusy(true);
    if (saved) {
      await supabase.from("favorite_providers").delete().eq("user_id", session.user.id).eq("provider_id", providerId);
      setSaved(false);
    } else {
      await supabase.from("favorite_providers").insert({ user_id: session.user.id, provider_id: providerId });
      setSaved(true);
    }
    // Don't leave the Profile tab's cached "Saved providers" list one toggle behind.
    cacheInvalidate(`profile:favProviders:${session.user.id}`);
    setBusy(false);
  }

  return { saved, toggle, busy, authed: Boolean(session) };
}

/** Favourite toggle for the signed-in parent.
 *
 *  QA: "On free plan, I'm able to click the heart button but it doesn't save
 *  to favourites as [it's a] plus feature — should have a pop up." The row was
 *  in fact being written, but the Favourites tab that shows it is Plus-only,
 *  so a free parent saw the heart fill and then found nothing on their list.
 *  Free parents now get told before anything is written; `locked` is what the
 *  heart uses to open the upgrade prompt. */
export function useFavorite(activityId: string | undefined, onToggled?: (saved: boolean) => void) {
  const { session } = useAuth();
  const { isPlus, loading: planLoading } = usePlan();
  // Saved state comes from the one shared favourites fetch (see lib/favorites),
  // not a per-card query. `busy` stays local — it's this heart's own click.
  const favorites = useFavoritesStore();
  const [busy, setBusy] = useState(false);
  const saved = Boolean(activityId) && favorites.isFavorited(activityId as string);
  // Never lock while the plan is still in flight — a Plus parent shouldn't be
  // shown an upgrade prompt because the request hadn't landed yet.
  const locked = Boolean(session) && !planLoading && !isPlus;

  /** Returns false when the click was refused because the parent is on free. */
  async function toggle(): Promise<boolean> {
    if (!activityId) return true;
    if (!session) {
      goTo("/login");
      return true;
    }
    if (locked) return false;
    setBusy(true);
    if (saved) {
      await supabase.from("favorites").delete().eq("user_id", session.user.id).eq("activity_id", activityId);
      favorites.setFavorited(activityId, false);
      onToggled?.(false);
    } else {
      await supabase.from("favorites").insert({ user_id: session.user.id, activity_id: activityId });
      favorites.setFavorited(activityId, true);
      onToggled?.(true);
    }
    // Don't leave the Profile tab's cached favourites list one toggle behind.
    cacheInvalidate(`profile:favs:${session.user.id}`);
    setBusy(false);
    return true;
  }

  return { saved, toggle, busy, locked, authed: Boolean(session) };
}

export interface ChildRecommendations {
  child: Child;
  recs: {
    id: string;
    score: number;
    reasons: string[];
    activity: (ActivityRow & { category_name?: string; category_name_2?: string }) | null;
  }[];
}

/** Recommendations are recomputed server-side by a job, never by anything the
 *  parent does here, so a cached set stays valid for a while. */
const RECS_FRESH_MS = 5 * 60_000;

export function useRecommendations(children: Child[]) {
  const ids = children.map((c) => c.id).join(",");
  const cacheKey = "recs:" + ids;
  const seed = ids ? cacheGet<ChildRecommendations[]>(cacheKey) : undefined;
  const [data, setData] = useState<ChildRecommendations[]>(seed?.data ?? []);
  const [loading, setLoading] = useState(!seed);
  // Which children `data` belongs to. The render that delivers the children
  // paints before the effect below re-enters loading, so without this that
  // frame showed an empty grid ahead of the skeleton.
  const [dataKey, setDataKey] = useState<string | null>(seed ? cacheKey : null);

  useEffect(() => {
    if (children.length === 0) {
      setData([]);
      setDataKey(cacheKey);
      setLoading(false);
      return;
    }
    let cancelled = false;
    const cached = cacheGet<ChildRecommendations[]>(cacheKey);
    if (cached) {
      setData(cached.data);
      setDataKey(cacheKey);
      setLoading(false);
      if (cached.age < RECS_FRESH_MS) return; // fresh — no refetch
      // else revalidate in the background, keeping the cached cards on screen
    } else {
      // Children arrive after auth resolves — a beat after the first (empty)
      // pass already flipped `loading` off. Re-enter loading here or the fetch
      // runs with `loading === false` and the section renders an empty grid.
      setLoading(true);
    }
    (async () => {
      // One IN(child_ids) query instead of one per child — ordered by
      // child_id then score so each child's rows stay contiguous and
      // already-sorted, letting the per-child top-8 below just slice instead
      // of re-sorting.
      const { data: recs } = await supabase
        .from("user_recommendations")
        // Sessions come along so the card can show a duration. Unlike the
        // Explore list, these rows don't go through `search_activities`
        // (which derives duration_mins server-side), and `activities` has
        // no duration column of its own.
        //
        // QA: "the activity type label for the pop outs under home and
        // suggested activities are incorrect… should be the same as under
        // explore". `activities` only carries `category_id`, so without
        // this join `toCard` had nothing to print and the card rendered an
        // empty category pill where Explore shows a real one.
        .select(
          "id, child_id, score, reasons, activities(*, activity_categories!activities_category_id_fkey(name), category_2:activity_categories!activities_secondary_category_id_fkey(name), providers(business_name, address, logo_url, cover_image_url, gallery_urls), activity_sessions(starts_at, ends_at, wix_slot_key))"
        )
        // Only the upcoming sessions ride along. Without this a Wix-linked
        // course carries every past slot it has ever run — hundreds of rows
        // per activity, times up to 8 recs, times each child — for a card
        // that only ever shows the next one. Matches the favourites fetch
        // in App.tsx. A rec whose activity has no upcoming session still
        // comes back (embedded filters don't drop the parent row); its card
        // falls back to "Schedule TBC", exactly as before.
        .gte("activities.activity_sessions.ends_at", new Date().toISOString())
        .in("child_id", children.map((c) => c.id))
        .order("child_id", { ascending: true })
        .order("score", { ascending: false });
      type RecRow = NonNullable<typeof recs>[number];
      const byChild = new Map<string, RecRow[]>();
      for (const r of recs ?? []) {
        const list = byChild.get(r.child_id) ?? [];
        list.push(r);
        byChild.set(r.child_id, list);
      }
      const out = children.map((child) => ({
        child,
        recs: (byChild.get(child.id) ?? []).slice(0, 8).map((r) => {
          const act = (r.activities as unknown as
            | (ActivityRow & {
                activity_categories?: { name: string } | null;
                category_2?: { name: string } | null;
                providers?: { business_name?: string | null; address?: string | null; logo_url?: string | null; cover_image_url?: string | null; gallery_urls?: string[] | null } | null;
              })
            | null) ?? null;
          return {
            id: r.id,
            score: r.score,
            reasons: r.reasons,
            activity: act
              ? { ...act, category_name: act.activity_categories?.name ?? undefined, category_name_2: act.category_2?.name ?? undefined }
              : null,
          };
        }),
      }));
      cacheSet(cacheKey, out);
      if (!cancelled) {
        setData(out);
        setDataKey(cacheKey);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids]);

  return { data, loading: loading || dataKey !== cacheKey };
}

export function useJourney(childId: string | undefined) {
  const [stats, setStats] = useState<JourneyStats | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!childId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    supabase
      .rpc("child_journey_stats", { p_child_id: childId })
      .then(({ data }) => {
        if (cancelled) return;
        setStats((data?.[0] as JourneyStats) ?? null);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [childId]);
  return { stats, loading };
}

/** Map a DB activity row → the content `Activity` card shape.
 *
 *  `providerName` and `region` matter here: QA found cards showing only the
 *  class name, because this mapper dropped both while the Explore list (which
 *  goes through `search_activities`) carried them. Rows come from `activities`,
 *  which keeps a denormalised `provider_name`; a joined `providers` row wins
 *  when the caller selected one. */
/** Card date/time formatting, matching useActivities' own so a listing reads
 *  the same on Explore as it does in Favourites. */
const sgCardDate = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString("en-SG", {
        timeZone: "Asia/Singapore",
        weekday: "short",
        day: "numeric",
        month: "short",
      })
    : "";
const sgCardTime = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleTimeString("en-SG", {
        timeZone: "Asia/Singapore",
        hour: "numeric",
        minute: "2-digit",
      })
    : "";

export function toCard(
  a: ActivityRow & {
    category_name?: string;
    category_name_2?: string;
    provider_name?: string | null;
    providers?: {
      business_name?: string | null; address?: string | null;
      // Optional — a caller that also selects these gets the same
      // provider-photo fallback Explore and the detail page use; one that
      // doesn't just keeps today's "own image or placeholder" behaviour.
      logo_url?: string | null; cover_image_url?: string | null; gallery_urls?: string[] | null;
    } | null;
    activity_sessions?: { starts_at: string; ends_at: string | null; wix_slot_key?: string | null }[] | null;
  }
) {
  // `search_activities` derives this server-side; here it comes off whichever
  // session has both ends, matching the RPC's definition — minus the whole-run
  // bookkeeping row ('wixcourse:…'), whose span is the entire course.
  // formatDuration decides how a long one reads ("3 days") or hides it.
  const timed = (a.activity_sessions ?? []).find(
    (s) => s.starts_at && s.ends_at && !(s.wix_slot_key ?? "").startsWith("wixcourse:")
  );
  const durationMins = timed
    ? Math.round((new Date(timed.ends_at as string).getTime() - new Date(timed.starts_at).getTime()) / 60000)
    : null;

  /* QA 24/08: "I added to the schedule on tinkers playdate but it still says
     'Schedule TBC' on the pop out in saved activities/favourites — it should
     update with the time and date of the next class."

     date/time were hardcoded empty here, so every card built through toCard
     (favourites, matches, suggestions) said "Schedule TBC" however full the
     schedule was — the card only ever had a real date on Explore, which gets
     next_session_at from search_activities. Derived here from the soonest
     upcoming session the caller passed in; a caller that fetches no sessions
     still falls back to "Schedule TBC", which is then honest. */
  const now = Date.now();
  const nextSession = (a.activity_sessions ?? [])
    .filter((sn) => sn.starts_at && new Date(sn.starts_at).getTime() >= now)
    .sort((x, y) => x.starts_at.localeCompare(y.starts_at))[0];

  /* A Wix COURSE is one booking for the whole run and can be joined once it has
     begun, so a run still in progress is what to show — not "Schedule TBC". The
     whole-run bookkeeping row ('wixcourse:…') is not an occurrence and would win
     by starting earliest, so it is left out. Mirrors search_activities (00144). */
  const run =
    a.wix_service_type === "COURSE"
      ? (a.activity_sessions ?? [])
          .filter(
            (sn) =>
              !(sn.wix_slot_key ?? "").startsWith("wixcourse:") &&
              new Date(sn.ends_at ?? sn.starts_at).getTime() > now
          )
          .sort((x, y) => x.starts_at.localeCompare(y.starts_at))[0]
      : undefined;
  const multiDayRun = !!run && isMultiDay(run.starts_at, run.ends_at);
  const when = multiDayRun
    ? { date: sgShortRange(run!.starts_at, run!.ends_at as string), time: "" }
    : !nextSession && run
      ? { date: sgCardDate(run.starts_at), time: sgCardTime(run.starts_at) }
      : { date: sgCardDate(nextSession?.starts_at ?? null), time: sgCardTime(nextSession?.starts_at ?? null) };

  return {
    id: a.id,
    slug: a.slug,
    title: a.title,
    category: a.category_name ?? "",
    category2: a.category_name_2 || undefined,
    image:
      resolveActivityImage(
        { image_urls: a.image_urls, image_source: a.image_source, cover_image_url: a.cover_image_url },
        a.providers ?? null
      ) ?? FALLBACK_LOGO_URL,
    age: formatAgeRange(a.age_min_months, a.age_max_months),
    // An activity with no address of its own inherits its provider's, same as
    // search_activities' coalesce(a.address, p.address) on Explore.
    venue: ((a.address ?? a.providers?.address) || "")
      .split(",")
      .map((s) => s.trim())
      .pop() ?? "",
    date: when.date,
    time: when.time,
    // Empty when there are no reviews, so the card drops the rating line
    // rather than printing a bare "New" beside nothing else.
    rating: a.rating_count > 0 ? `${Number(a.rating_avg).toFixed(1)} (${a.rating_count})` : "",
    providerName: a.providers?.business_name ?? a.provider_name ?? undefined,
    region: a.region ?? null,
    price: a.price ?? null,
    durationMins,
  };
}
