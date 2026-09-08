import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import { cacheGet, cacheSet } from "./queryCache";
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

/** A `search_activities` row. */
type SearchRow = {
  id: string;
  slug: string;
  title: string;
  category_name: string;
  image_urls: string[] | null;
  age_min_months: number;
  age_max_months: number;
  address: string | null;
  next_session_at: string | null;
  rating_avg: number;
  rating_count: number;
  boosted: boolean | null;
  latitude: number | null;
  longitude: number | null;
  provider_id: string | null;
  provider_name: string | null;
  price: number | null;
  region: SgRegion | null;
  duration_mins: number | null;
  instant_book: boolean | null;
};

/** Everything on the card comes straight off the search row; only `venues` and
 *  `areas` need the follow-up venue lookups, so they're passed in — empty on
 *  the first paint, precise once the enrichment lands. */
function toLiveActivity(
  r: SearchRow,
  venues: ActivityVenue[],
  areas: SgRegion[]
): LiveActivity {
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
}

/** The listing's own single region — what the Area filter falls back to before
 *  (or when) the per-venue lookups resolve. */
function fallbackRow(r: SearchRow): LiveActivity {
  const venues: ActivityVenue[] =
    r.latitude != null && r.longitude != null
      ? [{ name: r.provider_name ?? r.title, lat: r.latitude, lng: r.longitude, region: r.region }]
      : [];
  const areas = r.region ? [r.region] : [];
  return toLiveActivity(r, venues, areas);
}

/** How long a cached result is served without refetching. Explore's set
 *  changes rarely; past this the hook still shows the cached rows instantly
 *  but refreshes them in the background. */
const FRESH_MS = 60_000;

/**
 * Fetches published activities via the search_activities RPC and maps each row
 * into the content `Activity` shape used across the UI.
 *
 * Two-phase: the search RPC alone has everything the cards and every filter
 * except Area need, so its rows render immediately; the venue / session
 * lookups that draw the map pins and sharpen the Area filter merge in a beat
 * later without holding up the list. Results are cached (see queryCache) so
 * returning to Explore is instant.
 */
export function useActivities(params: ActivityQuery = {}) {
  const key = "activities:" + JSON.stringify(params);
  const seed = cacheGet<LiveActivity[]>(key);
  const [activities, setActivities] = useState<LiveActivity[]>(seed?.data ?? []);
  const [loading, setLoading] = useState(!seed);

  useEffect(() => {
    let cancelled = false;
    const cached = cacheGet<LiveActivity[]>(key);
    if (cached) {
      setActivities(cached.data);
      setLoading(false);
      if (cached.age < FRESH_MS) return; // fresh enough — no network at all
      // else: fall through and revalidate quietly, keeping the cached rows on
      // screen (no skeleton, no partial-data flash).
    } else {
      setActivities([]);
      setLoading(true);
    }
    const revalidating = Boolean(cached);

    (async () => {
      const { data } = await supabase.rpc("search_activities", {
        p_query: params.query ?? null,
        p_category_slug: params.category ?? null,
        p_age_months: params.ageMonths ?? null,
        p_sort: params.sort ?? "popular",
        p_limit: params.limit ?? 24,
      });
      const rows = (data ?? []) as SearchRow[];

      // Phase 1 — cards on screen now. Skipped when we're only revalidating a
      // cached full result (don't downgrade it to fallback venues mid-refresh).
      if (!cancelled && !revalidating) {
        setActivities(rows.map(fallbackRow));
        setLoading(false);
      }

      /* The venues each activity ACTUALLY runs at — its own venue, plus any
         venue an upcoming session overrides to (migration 00074).

         This used to pull every venue belonging to the activity's provider,
         which is what QA 17/08 hit: "I just have Sentosa selected and it is
         showing me Lucy Sparkles in East, Wildlings in Central, Muckypups
         East." All three own a Sentosa branch alongside branches elsewhere, so
         every class they run matched a Sentosa filter — and drew a pin there.

         Scoping to the activity is stricter than the data currently supports
         (most listings don't name a venue yet, and fall through to their own
         region), and that is the right way round. It sharpens on its own as
         vendors set per-session venues. */
      const activityIds = rows.map((r) => r.id);
      const providerIds = [
        ...new Set(rows.map((r) => r.provider_id).filter((x): x is string => !!x)),
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

      // Phase 2 — precise venues + areas.
      const mapped: LiveActivity[] = rows.map((r) => {
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
        /* When the activity names its own venues those are definitive — a class
           that only runs in Katong must not also answer to its provider's
           Central head-office region. With no venues named, the listing's own
           region is the best we have. */
        const areas = [
          ...new Set(
            (own.length > 0 ? own.map((v) => v.region) : [r.region as SgRegion | null]).filter(
              (x): x is SgRegion => !!x
            )
          ),
        ];
        return toLiveActivity(r, venues, areas);
      });

      cacheSet(key, mapped);
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
