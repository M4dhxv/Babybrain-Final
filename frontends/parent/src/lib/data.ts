import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import { useAuth } from "../auth/AuthProvider";
import {
  formatAgeRange,
  type Activity as ActivityRow,
  type ActivitySession,
  type Review,
  type Child,
  type JourneyStats,
} from "./database.types";

export interface ActivityDetail {
  activity: (ActivityRow & { category_name: string | null }) | null;
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
      const { data: act } = await supabase
        .from("activities")
        .select("*, activity_categories(name)")
        .eq("slug", slug)
        .maybeSingle();
      if (!act) {
        if (!cancelled) setState({ activity: null, sessions: [], reviews: [], loading: false });
        return;
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
export function useFavorite(activityId: string | undefined) {
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
    } else {
      await supabase.from("favorites").insert({ user_id: session.user.id, activity_id: activityId });
      setSaved(true);
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

/** Map a DB activity row → the content `Activity` card shape. */
export function toCard(a: ActivityRow & { category_name?: string }) {
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
  };
}
