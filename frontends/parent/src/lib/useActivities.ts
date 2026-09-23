import { useCallback, useEffect, useState } from "react";
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
   *  on (QA 17/08). Computed server-side now (see matching_activities in
   *  migration 00166), not from a follow-up venue query. */
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

/** Explore's filters, all applied server-side (see search_activities /
 *  matching_activities / search_activity_facets in migration 00166). `ages`
 *  is a single min/max range rather than a set of bands because the
 *  AgeTrack UI already collapses a multi-band pick into one covering span. */
export interface ActivityQuery {
  query?: string | null;
  /** Legacy single-category filter, still supported by the RPC — Explore
   *  itself always uses `categories` (multi-select). */
  category?: string | null;
  categories?: string[];
  ageMonths?: number | null;
  ageMinMonths?: number | null;
  ageMaxMonths?: number | null;
  regions?: string[];
  maxPrice?: number | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  timeMin?: number | null;
  timeMax?: number | null;
  sort?: SortOption;
  limit?: number;
}

/** A venue as `matching_activities`/`search_activities` return it (jsonb). */
type VenueRow = { name: string | null; lat: number; lng: number; region: SgRegion | null };

/** A `matching_activities` / `search_activities` row. */
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
  is_course?: boolean | null;
  run_starts_at?: string | null;
  run_ends_at?: string | null;
  // Added in 00166 — computed server-side now, see matching_activities.
  areas: SgRegion[] | null;
  venues: VenueRow[] | null;
};

/** A `search_activities` row — `matching_activities` plus the page's total. */
type SearchActivitiesRow = SearchRow & { total_count: number | null };

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
 *  occurrence still running. Everything else is the next session — already
 *  the specific one matching any date/time filter, per `next_session_at`
 *  (see matching_activities' `matchsess`). */
export function cardWhen(r: SearchRow): { date: string; time: string } {
  if (r.is_course && r.run_starts_at && r.run_ends_at) {
    if (isMultiDay(r.run_starts_at, r.run_ends_at)) {
      return { date: sgShortRange(r.run_starts_at, r.run_ends_at), time: "" };
    }
    if (!r.next_session_at) return { date: sgDate(r.run_starts_at), time: sgTime(r.run_starts_at) };
  }
  return { date: sgDate(r.next_session_at), time: sgTime(r.next_session_at) };
}

function toLiveActivity(r: SearchRow): LiveActivity {
  const venues: ActivityVenue[] = (r.venues ?? []).map((v) => ({
    name: v.name ?? "",
    lat: v.lat,
    lng: v.lng,
    region: v.region,
  }));
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
    isCourse: r.is_course ?? false,
    runStartsAt: r.is_course ? r.run_starts_at ?? null : null,
    runEndsAt: r.is_course ? r.run_ends_at ?? null : null,
    ageMinMonths: r.age_min_months,
    ageMaxMonths: r.age_max_months,
    region: r.region,
    durationMins: r.duration_mins,
    instantBook: r.instant_book ?? false,
    venues,
    areas: r.areas ?? [],
  };
}

/** The filter params every RPC in this file shares — `search_activities`,
 *  `matching_activities` (map pins) and `search_activity_facets` all take
 *  the same filter shape, just with pagination/limit on top for the first. */
function filterArgs(params: ActivityQuery) {
  return {
    p_query: params.query ?? null,
    p_category_slug: params.category ?? null,
    p_categories: params.categories?.length ? params.categories : null,
    p_age_months: params.ageMonths ?? null,
    p_age_min_months: params.ageMinMonths ?? null,
    p_age_max_months: params.ageMaxMonths ?? null,
    p_regions: params.regions?.length ? params.regions : null,
    p_max_price: params.maxPrice ?? null,
    p_date_from: params.dateFrom || null,
    p_date_to: params.dateTo || null,
    p_time_min: params.timeMin ?? null,
    p_time_max: params.timeMax ?? null,
  };
}

/** How long a cached result is served without refetching. Explore's set
 *  changes rarely; past this the hook still shows the cached rows instantly
 *  but refreshes them in the background. */
const FRESH_MS = 60_000;

const DEFAULT_PAGE_SIZE = 24;

/**
 * Fetches one page of published activities via the `search_activities` RPC —
 * filtering, sorting and pagination all happen in Postgres now (migration
 * 00166), so this only ever holds what's actually on screen: the loaded
 * pages, not the whole catalog. `total` is the full matching count (for "N
 * activities found" and whether there's more to load); `loadMore` fetches
 * the next page and appends it. Results are cached (see queryCache) so
 * returning to Explore is instant — only the first page is cached, so
 * "Show more" always goes live.
 */
export function useActivities(params: ActivityQuery = {}) {
  const key = "activities:" + JSON.stringify(params);
  const seed = cacheGet<{ rows: LiveActivity[]; total: number }>(key);
  const [activities, setActivities] = useState<LiveActivity[]>(seed?.data.rows ?? []);
  const [total, setTotal] = useState(seed?.data.total ?? 0);
  const [loading, setLoading] = useState(!seed);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const cached = cacheGet<{ rows: LiveActivity[]; total: number }>(key);
    if (cached) {
      setActivities(cached.data.rows);
      setTotal(cached.data.total);
      setLoading(false);
      if (cached.age < FRESH_MS) return; // fresh enough — no network at all
      // else: fall through and revalidate quietly, keeping the cached rows on
      // screen (no skeleton, no partial-data flash).
    } else {
      setActivities([]);
      setTotal(0);
      setLoading(true);
    }

    (async () => {
      const { data } = await supabase.rpc("search_activities", {
        ...filterArgs(params),
        p_sort: params.sort ?? "popular",
        p_limit: params.limit ?? DEFAULT_PAGE_SIZE,
        p_offset: 0,
      });
      if (cancelled) return;
      const rows = (data ?? []) as SearchActivitiesRow[];
      const mapped = rows.map(toLiveActivity);
      const t = rows[0]?.total_count ?? 0;
      cacheSet(key, { rows: mapped, total: t });
      setActivities(mapped);
      setTotal(t);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const loadMore = useCallback(async () => {
    setLoadingMore(true);
    const { data } = await supabase.rpc("search_activities", {
      ...filterArgs(params),
      p_sort: params.sort ?? "popular",
      p_limit: params.limit ?? DEFAULT_PAGE_SIZE,
      p_offset: activities.length,
    });
    const rows = (data ?? []) as SearchActivitiesRow[];
    const more = rows.map(toLiveActivity);
    setActivities((prev) => {
      const next = [...prev, ...more];
      cacheSet(key, { rows: next, total: rows[0]?.total_count ?? total });
      return next;
    });
    setLoadingMore(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, activities.length]);

  return { activities, total, loading, loadingMore, hasMore: activities.length < total, loadMore };
}

/**
 * Every activity matching the current filters (unpaginated) — feeds the
 * Explore map, which needs every pin regardless of how many cards have
 * loaded. Calls `matching_activities` directly (the shared core
 * `search_activities` also wraps), so it shares the exact filter semantics
 * without a second copy of them.
 */
export function useActivityPins(params: ActivityQuery = {}) {
  const key = "pins:" + JSON.stringify(params);
  const seed = cacheGet<LiveActivity[]>(key);
  const [activities, setActivities] = useState<LiveActivity[]>(seed?.data ?? []);
  const [loading, setLoading] = useState(!seed);

  useEffect(() => {
    let cancelled = false;
    const cached = cacheGet<LiveActivity[]>(key);
    if (cached) {
      setActivities(cached.data);
      setLoading(false);
      if (cached.age < FRESH_MS) return;
    } else {
      setLoading(true);
    }
    (async () => {
      const { data } = await supabase.rpc("matching_activities", filterArgs(params));
      if (cancelled) return;
      const rows = (data ?? []) as SearchRow[];
      const mapped = rows.map(toLiveActivity);
      cacheSet(key, mapped);
      setActivities(mapped);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return { activities, loading };
}

export interface FacetCounts {
  type: Record<string, number>;
  age: Record<string, number>;
  area: Record<string, number>;
}

/**
 * Per-option counts for the mobile filter sheets — "how many would match if
 * I also picked this" for each type/age/area option, each computed with
 * that one facet's own filter left out (search_activity_facets). Only
 * fetched while `enabled` (a sheet is actually open), same gating as before.
 */
export function useFacetCounts(params: ActivityQuery, enabled: boolean): FacetCounts | null {
  const [counts, setCounts] = useState<FacetCounts | null>(null);
  const key = enabled ? "facets:" + JSON.stringify(params) : null;

  useEffect(() => {
    if (!key) {
      setCounts(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const { data } = await supabase.rpc("search_activity_facets", filterArgs(params));
      if (cancelled) return;
      const rows = (data ?? []) as { facet: string; key: string; cnt: number }[];
      const next: FacetCounts = { type: {}, age: {}, area: {} };
      for (const row of rows) {
        const bucket = row.facet === "type" ? next.type : row.facet === "age" ? next.age : next.area;
        bucket[row.key] = Number(row.cnt);
      }
      setCounts(next);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return counts;
}
