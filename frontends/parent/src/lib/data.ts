import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import { apiGet } from "./api";
import { getPlanCache, setPlanCache, clearPlanCache, type Plan } from "./planCache";
import { useAuth } from "../auth/AuthProvider";
import { goTo } from "./nav";
import {
  formatAgeRange,
  type Activity as ActivityRow,
  type ActivitySession,
  type Review,
  type Child,
  type JourneyStats,
} from "./database.types";

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
  const cached = getPlanCache();
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
    const fresh = getPlanCache();
    if (fresh && Date.now() - fresh.at < 60_000) {
      setPlan(fresh.plan);
      setKnown(true);
      setLoading(false);
      return;
    }
    let cancelled = false;
    apiGet<{ plan: "free" | "plus" }>("/api/customer/stripe/subscription")
      .then((p) => {
        setPlanCache(p.plan);
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
 *  up without waiting on another round-trip. */
export function primePlan(plan: Plan) {
  setPlanCache(plan);
}

export interface ProviderContact {
  whatsapp: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  business_name: string | null;
  website: string | null;
}

/**
 * A locally-recorded session's `capacity` is the class's total capacity, not
 * what's left — "10 spots" stayed 10 even once 3 families had booked it.
 * Subtracts each session's confirmed/completed booking count (fetched via
 * the public booked-counts route, since "select own bookings" RLS blocks a
 * parent from counting other families' bookings directly) to get what's
 * actually still open. Wix-sourced slots already carry Wix's own remaining
 * count and are left alone — pass only locally-recorded sessions in.
 */
async function withRemainingCapacity<T extends { id: string; capacity: number | null }>(
  sessions: T[]
): Promise<T[]> {
  const ids = sessions.filter((s) => s.capacity != null).map((s) => s.id);
  if (ids.length === 0) return sessions;
  const { counts } = await apiGet<{ counts: Record<string, number> }>(
    `/api/public/booked-counts?sessionIds=${ids.join(",")}`
  ).catch(() => ({ counts: {} as Record<string, number> }));
  return sessions.map((s) =>
    s.capacity == null ? s : { ...s, capacity: Math.max(0, s.capacity - (counts[s.id] ?? 0)) }
  );
}

export interface ActivityDetail {
  activity:
    | (ActivityRow & {
        category_name: string | null;
        provider_contact: ProviderContact | null;
        // Messaging is a Growth-and-above perk — a Pay As You Grow provider
        // isn't reachable via chat, so the buttons grey out instead.
        provider_can_message: boolean;
      })
    | null;
  sessions: ActivitySession[];
  reviews: Review[];
  loading: boolean;
}

export function useActivityDetail(slug: string | null): ActivityDetail {
  const [state, setState] = useState<ActivityDetail>({
    activity: null,
    sessions: [],
    reviews: [],
    loading: true,
  });

  useEffect(() => {
    if (!slug) {
      setState((s) => ({ ...s, loading: false }));
      return;
    }
    let cancelled = false;
    (async () => {
      // Only published listings. QA reached "Storytime Stretch: Kids Yoga" — an
      // unpublished mock row with no linked provider — by direct link, and it
      // rendered a listing page with none of the contact buttons.
      const { data: act } = await supabase
        .from("activities")
        .select("*, activity_categories(name), providers(whatsapp, contact_phone, contact_email, business_name, website)")
        .eq("slug", slug)
        .eq("is_published", true)
        .maybeSingle();
      if (!act) {
        if (!cancelled) setState({ activity: null, sessions: [], reviews: [], loading: false });
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
      const sessionsPromise: Promise<ActivitySession[]> = act.wix_service_id
        ? Promise.all([
            apiGet<{ slots: { id: string; starts_at: string; ends_at: string; capacity: number }[] }>(
              `/api/wix/slots?activityId=${act.id}`
            )
              .then((r) =>
                r.slots.map((s) => ({
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
                  wix_slot_key: null,
                  wix_remaining_capacity: null,
                  created_at: new Date().toISOString(),
                }))
              )
              .catch(() => []),
            supabase
              .from("activity_sessions")
              .select("*")
              .eq("activity_id", act.id)
              .is("wix_slot_key", null)
              .gte("starts_at", new Date().toISOString())
              .order("starts_at")
              .limit(8)
              .then((r) => r.data ?? [])
              .then(withRemainingCapacity),
          ]).then(([wixSlots, independentSlots]) =>
            [...wixSlots, ...independentSlots].sort(
              (a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime()
            )
          )
        : Promise.resolve(
            supabase
              .from("activity_sessions")
              .select("*")
              .eq("activity_id", act.id)
              .gte("starts_at", new Date().toISOString())
              .order("starts_at")
              .limit(8)
              .then((r) => r.data ?? [])
              .then(withRemainingCapacity)
          );

      const [sessions, { data: reviews }, providerCanMessage] = await Promise.all([
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
      ]);
      if (!cancelled)
        setState({
          activity: {
            ...act,
            category_name:
              (act.activity_categories as unknown as { name: string } | null)?.name ?? null,
            provider_contact: (act.providers as unknown as ProviderContact | null) ?? null,
            provider_can_message: providerCanMessage,
          },
          sessions,
          reviews: reviews ?? [],
          loading: false,
        });
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
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  // Never lock while the plan is still in flight — a Plus parent shouldn't be
  // shown an upgrade prompt because the request hadn't landed yet.
  const locked = Boolean(session) && !planLoading && !isPlus;

  useEffect(() => {
    if (!session || !activityId) return;
    supabase
      .from("favorites")
      .select("activity_id")
      .eq("user_id", session.user.id)
      .eq("activity_id", activityId)
      .maybeSingle()
      .then(({ data }) => setSaved(Boolean(data)));
  }, [session, activityId]);

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
      setSaved(false);
      onToggled?.(false);
    } else {
      await supabase.from("favorites").insert({ user_id: session.user.id, activity_id: activityId });
      setSaved(true);
      onToggled?.(true);
    }
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
    activity: (ActivityRow & { category_name?: string }) | null;
  }[];
}

export function useRecommendations(children: Child[]) {
  const [data, setData] = useState<ChildRecommendations[]>([]);
  const [loading, setLoading] = useState(true);
  const ids = children.map((c) => c.id).join(",");

  useEffect(() => {
    if (children.length === 0) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      const out = await Promise.all(
        children.map(async (child) => {
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
              "id, score, reasons, activities(*, activity_categories(name), activity_sessions(starts_at, ends_at))"
            )
            .eq("child_id", child.id)
            .order("score", { ascending: false })
            .limit(8);
          return {
            child,
            recs: (recs ?? []).map((r) => {
              const act = (r.activities as unknown as
                | (ActivityRow & { activity_categories?: { name: string } | null })
                | null) ?? null;
              return {
                id: r.id,
                score: r.score,
                reasons: r.reasons,
                activity: act
                  ? { ...act, category_name: act.activity_categories?.name ?? undefined }
                  : null,
              };
            }),
          };
        })
      );
      if (!cancelled) {
        setData(out);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids]);

  return { data, loading };
}

export function useJourney(childId: string | undefined) {
  const [stats, setStats] = useState<JourneyStats | null>(null);
  useEffect(() => {
    if (!childId) return;
    supabase
      .rpc("child_journey_stats", { p_child_id: childId })
      .then(({ data }) => setStats((data?.[0] as JourneyStats) ?? null));
  }, [childId]);
  return stats;
}

/** Map a DB activity row → the content `Activity` card shape.
 *
 *  `providerName` and `region` matter here: QA found cards showing only the
 *  class name, because this mapper dropped both while the Explore list (which
 *  goes through `search_activities`) carried them. Rows come from `activities`,
 *  which keeps a denormalised `provider_name`; a joined `providers` row wins
 *  when the caller selected one. */
export function toCard(
  a: ActivityRow & {
    category_name?: string;
    provider_name?: string | null;
    providers?: { business_name?: string | null } | null;
    activity_sessions?: { starts_at: string; ends_at: string | null }[] | null;
  }
) {
  // `search_activities` derives this server-side; here it comes off whichever
  // session has both ends, matching the RPC's definition.
  const timed = (a.activity_sessions ?? []).find((s) => s.starts_at && s.ends_at);
  const durationMins = timed
    ? Math.round((new Date(timed.ends_at as string).getTime() - new Date(timed.starts_at).getTime()) / 60000)
    : null;

  return {
    id: a.id,
    slug: a.slug,
    title: a.title,
    category: a.category_name ?? "",
    image: a.image_urls?.[0] ?? `${import.meta.env.BASE_URL}assets/crops/activity-play.png`,
    age: formatAgeRange(a.age_min_months, a.age_max_months),
    venue: a.address ? a.address.split(",").map((s) => s.trim()).pop() ?? "" : "",
    date: "",
    time: "",
    // Empty when there are no reviews, so the card drops the rating line
    // rather than printing a bare "New" beside nothing else.
    rating: a.rating_count > 0 ? `${Number(a.rating_avg).toFixed(1)} (${a.rating_count})` : "",
    providerName: a.providers?.business_name ?? a.provider_name ?? undefined,
    region: a.region ?? null,
    price: a.price ?? null,
    durationMins,
  };
}
