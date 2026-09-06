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
  /** Every area this activity actually runs in — the areas of the venues it
   *  names, or its own single region when it names none. This, not `region`
   *  plus the provider's whole venue estate, is what the Area filter matches
   *  on (QA 17/08). */
  areas: SgRegion[];
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

      /* The venues each activity ACTUALLY runs at — its own venue, plus any
         venue an upcoming session overrides to (migration 00074).

         This used to pull every venue belonging to the activity's provider,
         which is what QA 17/08 hit: "I just have Sentosa selected and it is
         showing me Lucy Sparkles in East, Wildlings in Central, Muckypups
         East." All three own a Sentosa branch alongside branches elsewhere, so
         every class they run matched a Sentosa filter — and drew a pin there.
         19 providers span more than one area, so this was not a one-off.

         Scoping to the activity is stricter than the data currently supports
         (most listings don't name a venue yet, and fall through to their own
         region below), and that is the right way round: showing a Katong class
         under a Sentosa filter invites a booking in the wrong place, which is
         exactly what was reported. It sharpens on its own as vendors set
         per-session venues. */
      const activityIds = (rows ?? []).map((r) => r.id);
      const providerIds = [
        ...new Set((rows ?? []).map((r) => r.provider_id).filter((x): x is string => !!x)),
      ];
      const locationIdsByActivity = new Map<string, Set<string>>();
      const addLocation = (activityId: string, locationId: string | null) => {
        if (!locationId) return;
        const set = locationIdsByActivity.get(activityId) ?? new Set<string>();
        set.add(locationId);
        locationIdsByActivity.set(activityId, set);
      };
      if (activityIds.length) {
        const [ownVenues, sessionVenues] = await Promise.all([
          supabase.from("activities").select("id, location_id").in("id", activityIds),
          supabase
            .from("activity_sessions")
            .select("activity_id, location_id")
            .in("activity_id", activityIds)
            .not("location_id", "is", null)
            .gte("starts_at", new Date().toISOString()),
        ]);
        for (const a of (ownVenues.data ?? []) as unknown as Array<{ id: string; location_id: string | null }>) {
          addLocation(a.id, a.location_id);
        }
        for (const sv of (sessionVenues.data ?? []) as unknown as Array<{ activity_id: string; location_id: string | null }>) {
          addLocation(sv.activity_id, sv.location_id);
        }
      }

      // One round trip for every venue referenced above, plus each provider's
      // primary branch — the fallback for a listing that names no venue and
      // carries no coordinates of its own.
      const venuesById = new Map<string, ActivityVenue>();
      const primaryVenueByProvider = new Map<string, ActivityVenue>();
      const referencedLocationIds = [...new Set([...locationIdsByActivity.values()].flatMap((s) => [...s]))];
      if (referencedLocationIds.length || providerIds.length) {
        const { data: locs } = await supabase
          .from("provider_locations")
          .select("id, provider_id, name, latitude, longitude, region, is_primary")
          .or(
            [
              referencedLocationIds.length ? `id.in.(${referencedLocationIds.join(",")})` : null,
              providerIds.length ? `provider_id.in.(${providerIds.join(",")})` : null,
            ]
              .filter(Boolean)
              .join(",")
          );
        for (const l of (locs ?? []) as unknown as Array<{
          id: string;
          provider_id: string;
          name: string;
          latitude: number | null;
          longitude: number | null;
          region: SgRegion | null;
          is_primary: boolean | null;
        }>) {
          if (l.latitude == null || l.longitude == null) continue;
          const venue = { name: l.name, lat: l.latitude, lng: l.longitude, region: l.region };
          venuesById.set(l.id, venue);
          if (l.is_primary) primaryVenueByProvider.set(l.provider_id, venue);
        }
      }

      const mapped: LiveActivity[] = (rows ?? []).map((r) => {
        /* This activity's own venues, then the listing's own coordinate, then
           the provider's primary branch — so nothing is left off the map, but
           a listing never borrows a branch it doesn't teach at. */
        const own = [...(locationIdsByActivity.get(r.id) ?? [])]
          .map((id) => venuesById.get(id))
          .filter((v): v is ActivityVenue => !!v);
        const fallback =
          r.latitude != null && r.longitude != null
            ? [{ name: r.provider_name ?? r.title, lat: r.latitude, lng: r.longitude, region: r.region }]
            : r.provider_id && primaryVenueByProvider.has(r.provider_id)
              ? [primaryVenueByProvider.get(r.provider_id)!]
              : [];
        const venues = own.length > 0 ? own : fallback;
        /* The areas the Area filter matches on. When the activity names its
           own venues those are definitive — a class that only runs in Katong
           must not also answer to its provider's Central head-office region.
           With no venues named, the listing's own region is the best we have. */
        const areas = [
          ...new Set(
            (own.length > 0
              ? own.map((v) => v.region)
              : [r.region as SgRegion | null]
            ).filter((x): x is SgRegion => !!x)
          ),
        ];

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
          areas,
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
