import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import { apiGet } from "./api";
import { useAuth } from "../auth/AuthProvider";
import {
  formatAgeRange,
  type Activity as ActivityRow,
  type ActivitySession,
  type Review,
  type Child,
  type JourneyStats,
} from "./database.types";

/** The signed-in parent's plan, cached for the tab so every gated control
 *  doesn't re-request it. Defaults to `free` until we know otherwise, so a
 *  slow response never briefly unlocks a Plus feature. */
let planCache: { plan: "free" | "plus"; at: number } | null = null;

export function usePlan() {
  const { session, loading: authLoading } = useAuth();
  const [plan, setPlan] = useState<"free" | "plus">(planCache?.plan ?? "free");
  const [loading, setLoading] = useState(!planCache);

  useEffect(() => {
    if (authLoading) return;
    if (!session) {
      setPlan("free");
      setLoading(false);
      return;
    }
    // 60s is short enough that returning from Stripe shows the new plan.
    if (planCache && Date.now() - planCache.at < 60_000) {
      setPlan(planCache.plan);
      setLoading(false);
      return;
    }
    let cancelled = false;
    apiGet<{ plan: "free" | "plus" }>("/api/customer/stripe/subscription")
      .then((p) => {
        planCache = { plan: p.plan, at: Date.now() };
        if (!cancelled) setPlan(p.plan);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session, authLoading]);

  return { plan, isPlus: plan === "plus", loading };
}

/** Drop the cached plan after an upgrade so the UI unlocks immediately. */
export function invalidatePlan() {
  planCache = null;
}

export interface ProviderContact {
  whatsapp: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  business_name: string | null;
  website: string | null;
}

export interface ActivityDetail {
  activity: (ActivityRow & { category_name: string | null; provider_contact: ProviderContact | null }) | null;
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
      const [{ data: sessions }, { data: reviews }] = await Promise.all([
        supabase
          .from("activity_sessions")
          .select("*")
          .eq("activity_id", act.id)
          .gte("starts_at", new Date().toISOString())
          .order("starts_at")
          .limit(8),
        supabase
          .from("reviews")
          .select("*")
          .eq("activity_id", act.id)
          .order("created_at", { ascending: false })
          .limit(10),
      ]);
      if (!cancelled)
        setState({
          activity: {
            ...act,
            category_name:
              (act.activity_categories as unknown as { name: string } | null)?.name ?? null,
            provider_contact: (act.providers as unknown as ProviderContact | null) ?? null,
          },
          sessions: sessions ?? [],
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
      window.location.href = "/login";
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

/** Favourite toggle for the signed-in parent. */
export function useFavorite(activityId: string | undefined, onToggled?: (saved: boolean) => void) {
  const { session } = useAuth();
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

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

  async function toggle() {
    if (!activityId) return;
    if (!session) {
      window.location.href = "/login";
      return;
    }
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
  }

  return { saved, toggle, busy, authed: Boolean(session) };
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
            .select("id, score, reasons, activities(*)")
            .eq("child_id", child.id)
            .order("score", { ascending: false })
            .limit(8);
          return {
            child,
            recs: (recs ?? []).map((r) => ({
              id: r.id,
              score: r.score,
              reasons: r.reasons,
              activity: (r.activities as unknown as ActivityRow) ?? null,
            })),
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
  }
) {
  return {
    id: a.id,
    slug: a.slug,
    title: a.title,
    category: a.category_name ?? "",
    image: a.image_urls?.[0] ?? `${import.meta.env.BASE_URL}assets/crops/activity-music.png`,
    age: formatAgeRange(a.age_min_months, a.age_max_months),
    venue: a.address ? a.address.split(",").map((s) => s.trim()).pop() ?? "" : "",
    date: "",
    time: "",
    rating: a.rating_count > 0 ? `${Number(a.rating_avg).toFixed(1)} (${a.rating_count})` : "New",
    note: "",
    providerName: a.providers?.business_name ?? a.provider_name ?? undefined,
    region: a.region ?? null,
    price: a.price ?? null,
  };
}
