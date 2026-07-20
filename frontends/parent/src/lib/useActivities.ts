import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import { formatAgeRange, type SortOption } from "./database.types";
import type { Activity } from "../data/content";

/** Live activity carrying the content `Activity` shape (so ActivityCard /
 *  ActivityRow render unchanged) plus slug/id for linking and favourites, and
 *  the provider's coordinates (when known) for the Explore map. */
export type LiveActivity = Activity & {
  slug: string;
  id: string;
  lat?: number;
  lng?: number;
  providerName?: string;
  price?: number | null;
  nextSessionAt?: string | null;
};

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

      // search_activities omits the street address and coordinates; fetch them
      // (coords live on the provider) for the venue line and the map pins.
      const ids = (rows ?? []).map((r) => r.id);
      const addressById = new Map<string, string | null>();
      const nameById = new Map<string, string | null>();
      const coordsById = new Map<string, { lat: number; lng: number; name: string | null }>();
      if (ids.length) {
        const { data: addrs } = await supabase
          .from("activities")
          .select("id, address, provider_name, providers(latitude, longitude, business_name)")
          .in("id", ids);
        (addrs ?? []).forEach((a) => {
          addressById.set(a.id, a.address);
          const p = (a as unknown as { provider_name: string | null; providers: { latitude: number | null; longitude: number | null; business_name: string | null } | null });
          // Prefer the provider's live business_name, falling back to the
          // denormalised provider_name column on the activity.
          nameById.set(a.id, p.providers?.business_name ?? p.provider_name ?? null);
          if (p.providers?.latitude != null && p.providers?.longitude != null) {
            coordsById.set(a.id, { lat: p.providers.latitude, lng: p.providers.longitude, name: p.providers.business_name });
          }
        });
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
        // Prefer the provider's coordinates; fall back to the activity's own
        // lat/lng from the RPC so more listings get a map pin.
        lat: coordsById.get(r.id)?.lat ?? r.latitude ?? undefined,
        lng: coordsById.get(r.id)?.lng ?? r.longitude ?? undefined,
        providerName: nameById.get(r.id) ?? undefined,
        price: r.price ?? null,
        nextSessionAt: r.next_session_at ?? null,
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
