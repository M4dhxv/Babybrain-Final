import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import { formatAgeRange, type SortOption } from "./database.types";
import type { Activity } from "../data/content";

/** Live activity carrying the content `Activity` shape (so ActivityCard /
 *  ActivityRow render unchanged) plus slug/id for linking and favourites. */
export type LiveActivity = Activity & { slug: string; id: string };

const sgDate = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString("en-SG", {
        timeZone: "Asia/Singapore",
        weekday: "short",
        day: "numeric",
        month: "short",
      })
    : "";
const sgTime = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleTimeString("en-SG", {
        timeZone: "Asia/Singapore",
        hour: "numeric",
        minute: "2-digit",
      })
    : "";
const area = (address: string | null) =>
  address ? address.split(",").map((s) => s.trim()).pop() ?? "" : "";

export interface ActivityQuery {
  query?: string | null;
  category?: string | null;
  ageMonths?: number | null;
  sort?: SortOption;
  limit?: number;
}

/** Fetches published activities via the search_activities RPC and maps each
 *  row into the content `Activity` shape used across the UI. */
export function useActivities(params: ActivityQuery = {}) {
  const [activities, setActivities] = useState<LiveActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const key = JSON.stringify(params);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      const { data: rows } = await supabase.rpc("search_activities", {
        p_query: params.query ?? null,
        p_category_slug: params.category ?? null,
        p_age_months: params.ageMonths ?? null,
        p_sort: params.sort ?? "popular",
        p_limit: params.limit ?? 24,
      });

      // search_activities omits the street address; fetch it for the venue line.
      const ids = (rows ?? []).map((r) => r.id);
      const addressById = new Map<string, string | null>();
      if (ids.length) {
        const { data: addrs } = await supabase
          .from("activities")
          .select("id, address")
          .in("id", ids);
        (addrs ?? []).forEach((a) => addressById.set(a.id, a.address));
      }

      const mapped: LiveActivity[] = (rows ?? []).map((r) => ({
        id: r.id,
        slug: r.slug,
        title: r.title,
        category: r.category_name,
        image: r.image_urls?.[0] ?? `${import.meta.env.BASE_URL}assets/crops/activity-music.png`,
        age: formatAgeRange(r.age_min_months, r.age_max_months),
        venue: area(addressById.get(r.id) ?? null),
        date: sgDate(r.next_session_at),
        time: sgTime(r.next_session_at),
        rating: r.rating_count > 0 ? `${Number(r.rating_avg).toFixed(1)} (${r.rating_count})` : "New",
        note: r.popularity > 2 ? "Popular this week" : "",
        boosted: r.boosted ?? false,
      }));

      if (!cancelled) {
        setActivities(mapped);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return { activities, loading };
}
