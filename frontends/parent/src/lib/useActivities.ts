import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import { formatAgeRange, type SgRegion, type SortOption } from "./database.types";
import type { Activity } from "../data/content";

/** One physical venue a listing runs at. Multi-venue businesses (Kindermusik,
 *  Lucy Sparkles, My Gym…) keep several, and every one gets a map pin. */
export interface ActivityVenue {
  name: string;
  lat: number;
  lng: number;
  region: SgRegion | null;
}

/** Live activity carrying the content `Activity` shape (so ActivityCard /
 *  ActivityRow render unchanged) plus slug/id for linking and favourites, the
 *  venues for the Explore map, and the extras the cards show (price from,
 *  duration, area). */
export type LiveActivity = Activity & {
  slug: string;
  id: string;
  lat?: number;
  lng?: number;
  providerId?: string | null;
  providerName?: string;
  price?: number | null;
  nextSessionAt?: string | null;
  ageMinMonths: number;
  ageMaxMonths: number;
  region?: SgRegion | null;
  durationMins?: number | null;
  instantBook: boolean;
  venues: ActivityVenue[];
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

      // Pull every venue of the providers on this page in one round trip, so
      // multi-location businesses get a pin per venue rather than one pin at
      // their head office.
      const providerIds = [
        ...new Set((rows ?? []).map((r) => r.provider_id).filter((x): x is string => !!x)),
      ];
      const venuesByProvider = new Map<string, ActivityVenue[]>();
      if (providerIds.length) {
        const { data: locs } = await supabase
          .from("provider_locations")
          .select("provider_id, name, latitude, longitude, region")
          .in("provider_id", providerIds);
        for (const l of (locs ?? []) as unknown as Array<{
          provider_id: string;
          name: string;
          latitude: number | null;
          longitude: number | null;
          region: SgRegion | null;
        }>) {
          if (l.latitude == null || l.longitude == null) continue;
          const list = venuesByProvider.get(l.provider_id) ?? [];
          list.push({ name: l.name, lat: l.latitude, lng: l.longitude, region: l.region });
          venuesByProvider.set(l.provider_id, list);
        }
      }

      const mapped: LiveActivity[] = (rows ?? []).map((r) => {
        // Fall back to the listing's own coordinate when the provider has no
        // venue rows, so nothing in the list is left off the map.
        const venues =
          (r.provider_id ? venuesByProvider.get(r.provider_id) : undefined) ??
          (r.latitude != null && r.longitude != null
            ? [
                {
                  name: r.provider_name ?? r.title,
                  lat: r.latitude,
                  lng: r.longitude,
                  region: r.region,
                },
              ]
            : []);

        return {
          id: r.id,
          slug: r.slug,
          title: r.title,
          category: r.category_name,
          image: r.image_urls?.[0] ?? `${import.meta.env.BASE_URL}assets/crops/activity-play.png`,
          age: formatAgeRange(r.age_min_months, r.age_max_months),
          venue: r.address ? r.address.split(",").map((s) => s.trim()).pop() ?? "" : "",
          date: sgDate(r.next_session_at),
          time: sgTime(r.next_session_at),
          // Empty when there are no reviews yet, so the card drops the rating
          // line entirely instead of showing a bare "New".
          rating: r.rating_count > 0 ? `${Number(r.rating_avg).toFixed(1)} (${r.rating_count})` : "",
          boosted: r.boosted ?? false,
          lat: r.latitude ?? venues[0]?.lat ?? undefined,
          lng: r.longitude ?? venues[0]?.lng ?? undefined,
          providerId: r.provider_id,
          providerName: r.provider_name ?? undefined,
          price: r.price ?? null,
          nextSessionAt: r.next_session_at ?? null,
          ageMinMonths: r.age_min_months,
          ageMaxMonths: r.age_max_months,
          region: r.region,
          durationMins: r.duration_mins,
          instantBook: r.instant_book ?? false,
          venues,
        };
      });

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
