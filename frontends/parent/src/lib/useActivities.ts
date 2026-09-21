import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import { cacheGet, cacheSet } from "./queryCache";
import { formatAgeRange, type SgRegion, type SortOption } from "./database.types";
import type { Activity } from "../data/content";
import { resolveActivityImage, FALLBACK_LOGO_URL } from "./activityMedia";
import { isMultiDay, sgShortRange } from "./schedule";

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
  /** Start time of every upcoming session, so the date and time-of-day filters can match an
   *  activity on ANY of its sessions, not just the next one. Undefined until the second load
   *  phase lands; the filters then fall back to `nextSessionAt`. */
  sessionStarts?: string[];
  /** A Wix COURSE is enrolled as one booking for the whole run, so it can still
   *  be joined once it has begun. `runStartsAt`/`runEndsAt` are the occurrence a
   *  parent can still join — in progress or upcoming — which `nextSessionAt`
   *  (sessions not yet started) can't express. Null for anything else. */
  isCourse?: boolean;
  runStartsAt?: string | null;
  runEndsAt?: string | null;
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
export type SearchRow = {
  id: string;
  slug: string;
  title: string;
  category_name: string;
  // Added in 00153 — optional so the app still works if it deploys first.
  category_2_name?: string | null;
  category_2_slug?: string | null;
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
  image_source: string | null;
  cover_image_url: string | null;
  provider_logo_url: string | null;
  provider_cover_image_url: string | null;
  provider_gallery_urls: string[] | null;
  // Added in 00144 — optional so the app still works if it deploys first.
  is_course?: boolean | null;
  run_starts_at?: string | null;
  run_ends_at?: string | null;
};

/** The card's date and time for one specific session start (used when a filter picked
 *  a session other than the next one). */
export function whenAt(iso: string): { date: string; time: string } {
  return { date: sgDate(iso), time: sgTime(iso) };
}

/** The card's date and time. A multi-day course run (a camp Wix sends as one
 *  continuous occurrence) has no time of day, so it reads as its date range —
 *  "17 – 20 Sept" — rather than the start time of its first midnight. A course
 *  that has already begun has no *upcoming* session, which used to leave the
 *  card saying "Schedule TBC" while places were open; it falls back to the
 *  occurrence still running. Everything else is the next session, as before. */
export function cardWhen(r: SearchRow): { date: string; time: string } {
  if (r.is_course && r.run_starts_at && r.run_ends_at) {
    if (isMultiDay(r.run_starts_at, r.run_ends_at)) {
      return { date: sgShortRange(r.run_starts_at, r.run_ends_at), time: "" };
    }
    if (!r.next_session_at) return { date: sgDate(r.run_starts_at), time: sgTime(r.run_starts_at) };
  }
  return { date: sgDate(r.next_session_at), time: sgTime(r.next_session_at) };
}

/** Everything on the card comes straight off the search row; only `venues` and
 *  `areas` need the follow-up venue lookups, so they're passed in — empty on
 *  the first paint, precise once the enrichment lands. */
function toLiveActivity(
  r: SearchRow,
  venues: ActivityVenue[],
  areas: SgRegion[],
  sessionStarts?: string[]
): LiveActivity {
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    category: r.category_name,
    category2: r.category_2_name ?? undefined,
    // Falls back to the provider's own cover/logo/gallery when this listing
    // has no photos of its own (or is explicitly set to borrow theirs) —
    // see activityMedia.ts. Only the static crop is a true last resort.
    image:
      resolveActivityImage(
        { image_urls: r.image_urls, image_source: r.image_source, cover_image_url: r.cover_image_url },
        { logo_url: r.provider_logo_url, cover_image_url: r.provider_cover_image_url, gallery_urls: r.provider_gallery_urls }
      ) ?? FALLBACK_LOGO_URL,
    age: formatAgeRange(r.age_min_months, r.age_max_months),
    venue: r.address ? r.address.split(",").map((s) => s.trim()).pop() ?? "" : "",
    ...cardWhen(r),
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
    sessionStarts,
    isCourse: r.is_course ?? false,
    runStartsAt: r.is_course ? r.run_starts_at ?? null : null,
    runEndsAt: r.is_course ? r.run_ends_at ?? null : null,
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

const SESSION_PAGE = 1000; // the API returns at most this many rows per request
const SESSION_MAX_PAGES = 15;

/** Every upcoming, non-cancelled session for these activities. A single request
 *  is capped server-side (max_rows), which would silently drop the later slots of
 *  busy schedules, so this pages through until a short page comes back. */
async function fetchUpcomingSessions(activityIds: string[]) {
  const nowIso = new Date().toISOString();
  const rows: Array<{ activity_id: string; location_id: string | null; starts_at: string }> = [];
  for (let page = 0; page < SESSION_MAX_PAGES; page++) {
    const { data } = await supabase
      .from("activity_sessions")
      .select("activity_id, location_id, starts_at")
      .in("activity_id", activityIds)
      .neq("status", "cancelled")
      .gte("starts_at", nowIso)
      .order("starts_at")
      .order("id")
      .range(page * SESSION_PAGE, (page + 1) * SESSION_PAGE - 1);
    const got = (data ?? []) as unknown as typeof rows;
    rows.push(...got);
    if (got.length < SESSION_PAGE) break;
  }
  return { data: rows };
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
      const startsByActivity = new Map<string, string[]>();
      const addLocation = (activityId: string, locationId: string | null) => {
        if (!locationId) return;
        const set = locationIdsByActivity.get(activityId) ?? new Set<string>();
        set.add(locationId);
        locationIdsByActivity.set(activityId, set);
      };
      if (activityIds.length) {
        const [ownVenues, sessionVenues] = await Promise.all([
          supabase.from("activities").select("id, location_id").in("id", activityIds),
          // Also feeds sessionStarts (every upcoming start time) for the time / date filters.
          fetchUpcomingSessions(activityIds),
        ]);
        for (const a of (ownVenues.data ?? []) as unknown as Array<{ id: string; location_id: string | null }>) {
          addLocation(a.id, a.location_id);
        }
        for (const sv of (sessionVenues.data ?? []) as unknown as Array<{ activity_id: string; location_id: string | null; starts_at: string }>) {
          addLocation(sv.activity_id, sv.location_id);
          const list = startsByActivity.get(sv.activity_id) ?? [];
          list.push(sv.starts_at);
          startsByActivity.set(sv.activity_id, list);
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
        return toLiveActivity(r, venues, areas, startsByActivity.get(r.id));
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
