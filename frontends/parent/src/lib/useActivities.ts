import { useCallback, useEffect, useRef, useState } from "react";
import { cacheGet, cacheSet } from "./queryCache";
import { withRetry } from "./retry";
import { catalogRpc, reportCatalogFailure } from "./catalog";
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
  /** Where the parent is, for sort "distance" - ranked in Postgres across the
   *  whole result set, not just the rows loaded so far. */
  lat?: number | null;
  lng?: number | null;
  /** Areas nearest-first, used when `lat`/`lng` is only an area's centre (the
   *  "pick your area" fallback): the whole nearest area ranks before the next. */
  regionOrder?: string[] | null;
  limit?: number;
  /** Rows fetched per `loadMore()` call — separate from `limit` (the first
   *  page's size), for a caller that reveals its own rows client-side a few
   *  at a time and only calls `loadMore()` once the loaded batch runs out
   *  (Explore's "Load more"). Defaults to LOAD_MORE_PAGE_SIZE. */
  loadMoreLimit?: number;
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
  // Added in 00175 — a private session at the customer's own home.
  is_custom_location?: boolean | null;
  custom_location_label?: string | null;
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
    isCustomLocation: r.is_custom_location ?? false,
    customLocationLabel: r.custom_location_label ?? null,
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

/** A burst of filter changes (dragging the age slider, tapping chips) should
 *  cost the database one query, not one per tap: aborting in the browser does
 *  not stop Postgres running a query it already started. The first load of
 *  the page is never delayed. */
const SETTLE_MS = 250;
/** The class list is what a parent came for; the map pins and per-option
 *  counts wait behind it so the three queries don't all hit the database in
 *  the same instant. */
const PINS_AFTER_MS = 500;
const FACETS_AFTER_MS = 300;

const DEFAULT_PAGE_SIZE = 24;
/** Rows pulled per background fetch once the caller has revealed everything
 *  already in memory — a real network round trip, so it's sized like a page
 *  (matching DEFAULT_PAGE_SIZE), not like a single reveal step. A caller that
 *  reveals loaded rows a few at a time (Explore's "Load more") only hits this
 *  once per batch, not once per click. */
const LOAD_MORE_PAGE_SIZE = DEFAULT_PAGE_SIZE;

/** Everything that decides which rows come back, in the order they come back. */
function searchArgs(params: ActivityQuery) {
  return {
    ...filterArgs(params),
    p_sort: params.sort ?? "popular",
    // ~1 km grid: parents a street apart share one cached answer.
    p_lat: params.lat != null ? Math.round(params.lat * 100) / 100 : null,
    p_lng: params.lng != null ? Math.round(params.lng * 100) / 100 : null,
    // Only sent when set: a database that hasn't had migration 00220 yet
    // rejects an argument it doesn't know, even a null one.
    ...(params.regionOrder?.length ? { p_region_order: params.regionOrder } : {}),
  };
}

type Page = { rows: LiveActivity[]; total: number };

/**
 * Fetches one page of published activities via the `search_activities` RPC —
 * filtering, sorting and pagination all happen in Postgres (migrations 00166,
 * 00219), so this only ever holds what's actually on screen: the loaded pages,
 * not the whole catalog. `total` is the full matching count (for "N
 * activities found" and whether there's more to load); `loadMore` fetches the
 * next page and appends it. Results are cached (see queryCache) so returning
 * to Explore is instant — only the first page is cached, so "Show more"
 * always goes live.
 *
 * Correctness rules this hook holds to:
 *  - The rows and the count always belong to the *current* query. They are
 *    stored against the query's key and read back only when it matches, so a
 *    filter change can never show the previous filter's rows or count (the
 *    old "21 found, nothing listed" / "everything listed, then zero").
 *  - A failed or timed-out request is an `error`, never "no results", and is
 *    never cached. Slow requests are cut off and retried, so `loading` always
 *    ends.
 *  - A superseded request is aborted, so quick filter changes don't pile up
 *    work in the database, and a late answer can't overwrite a newer one.
 */
export function useActivities(params: ActivityQuery = {}) {
  const args = searchArgs(params);
  const key = "activities:" + JSON.stringify({ ...args, limit: params.limit ?? DEFAULT_PAGE_SIZE });
  const cachedNow = cacheGet<Page>(key);

  // `fetched` is only ever trusted when it was fetched for this exact key.
  const [fetched, setFetched] = useState<{ key: string; page: Page } | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  const view: Page | null = fetched?.key === key ? fetched.page : cachedNow?.data ?? null;
  const activities = view?.rows ?? [];
  const total = view?.total ?? 0;
  const error = failedKey === key;
  const loading = !view && !error;

  const latest = useRef({ key, view });
  latest.current = { key, view };

  // Only the page's very first run goes out at once; every later change
  // (including one that follows a cache hit) waits for taps to settle.
  const firstRun = useRef(true);
  useEffect(() => {
    const ctl = new AbortController();
    const immediate = firstRun.current;
    firstRun.current = false;
    const cached = cacheGet<Page>(key);
    if (cached && cached.age < FRESH_MS && attempt === 0) return; // fresh enough — no network at all
    // else: revalidate quietly, keeping any cached rows for *this* key on screen.
    setFailedKey(null);

    const run = async () => {
      const { data, error: rpcError } = await withRetry(
        (signal) =>
          catalogRpc("search_activities", { ...args, p_limit: params.limit ?? DEFAULT_PAGE_SIZE, p_offset: 0 }, signal),
        { signal: ctl.signal },
      );
      if (ctl.signal.aborted) return;
      if (rpcError) {
        reportCatalogFailure("list", rpcError);
        setFailedKey(key);
        return;
      }
      const rows = (data ?? []) as SearchActivitiesRow[];
      const mapped = rows.map(toLiveActivity);
      // total_count rides on every row; it can never be below what we hold.
      const t = Math.max(Number(rows[0]?.total_count ?? 0), mapped.length);
      // A background refresh only re-reads the first page. If the parent had
      // already loaded more ("Load more"), keep those further rows rather than
      // collapsing the list back to one page on return from an activity.
      const have = new Set(mapped.map((r) => r.id));
      const kept = cached && cached.data.rows.length > mapped.length
        ? cached.data.rows.slice(mapped.length).filter((r) => !have.has(r.id))
        : [];
      const merged = kept.length ? [...mapped, ...kept] : mapped;
      const page = { rows: merged, total: Math.max(t, merged.length) };
      cacheSet(key, page);
      setFetched({ key, page });
    };
    const timer = setTimeout(run, immediate || attempt > 0 ? 0 : SETTLE_MS);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt]);

  const loadingMoreRef = useRef(false);
  const loadMore = useCallback(async () => {
    const { key: forKey, view: current } = latest.current;
    if (loadingMoreRef.current || !current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    const { data, error: rpcError } = await withRetry((signal) =>
      catalogRpc(
        "search_activities",
        { ...args, p_limit: params.loadMoreLimit ?? LOAD_MORE_PAGE_SIZE, p_offset: current.rows.length },
        signal,
      )
    );
    loadingMoreRef.current = false;
    setLoadingMore(false);
    // The parent changed filters while this was in flight: it belongs to a
    // query that's no longer on screen.
    if (latest.current.key !== forKey) return;
    if (rpcError) {
      reportCatalogFailure("load-more", rpcError);
      setFailedKey(forKey);
      return;
    }
    setFailedKey(null);
    const batch = (data ?? []) as SearchActivitiesRow[];
    const more = batch.map(toLiveActivity);
    const have = new Set(current.rows.map((r) => r.id));
    const rows = [...current.rows, ...more.filter((r) => !have.has(r.id))];
    // An empty batch means the catalogue shrank since the count was taken:
    // trust what came back so "Load more" can't keep offering nothing.
    const rawTotal = Number(batch[0]?.total_count ?? current.total);
    const page = { rows, total: more.length === 0 ? rows.length : Math.max(rawTotal, rows.length) };
    cacheSet(forKey, page);
    setFetched({ key: forKey, page });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return { activities, total, loading, loadingMore, hasMore: activities.length < total, loadMore, error, reload };
}

/**
 * Every activity matching the current filters (unpaginated) — feeds the
 * Explore map, which needs every pin regardless of how many cards have
 * loaded. Calls `matching_activities` directly (the shared core
 * `search_activities` also wraps), so it shares the exact filter semantics
 * without a second copy of them.
 */
export function useActivityPins(params: ActivityQuery = {}) {
  // Filters only: sort and page size don't change which pins exist, so they
  // stay out of the key (changing the sort used to refetch every pin).
  const args = filterArgs(params);
  const key = "pins:" + JSON.stringify(args);
  const cachedNow = cacheGet<LiveActivity[]>(key);
  const [fetched, setFetched] = useState<{ key: string; rows: LiveActivity[] } | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  // Pins from another filter are never shown for this one.
  const rows = fetched?.key === key ? fetched.rows : cachedNow?.data ?? null;
  const error = failedKey === key;

  useEffect(() => {
    const ctl = new AbortController();
    const cached = cacheGet<LiveActivity[]>(key);
    if (cached && cached.age < FRESH_MS && attempt === 0) return;
    setFailedKey(null);
    const run = async () => {
      const { data, error: rpcError } = await withRetry(
        (signal) => catalogRpc("matching_activities", args, signal),
        { signal: ctl.signal },
      );
      if (ctl.signal.aborted) return;
      if (rpcError) {
        reportCatalogFailure("pins", rpcError);
        setFailedKey(key); // never cached
        return;
      }
      const mapped = ((data ?? []) as SearchRow[]).map(toLiveActivity);
      cacheSet(key, mapped);
      setFetched({ key, rows: mapped });
    };
    const timer = setTimeout(run, PINS_AFTER_MS);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt]);

  return { activities: rows ?? [], loading: !rows && !error, error, reload };
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
  const [result, setResult] = useState<{ key: string; counts: FacetCounts } | null>(null);
  const key = enabled ? "facets:" + JSON.stringify(filterArgs(params)) : null;

  useEffect(() => {
    if (!key) return;
    const ctl = new AbortController();
    const run = async () => {
      const { data, error: rpcError } = await withRetry(
        (signal) => catalogRpc("search_activity_facets", filterArgs(params), signal),
        { signal: ctl.signal },
      );
      if (ctl.signal.aborted || rpcError) return;
      const rows = (data ?? []) as { facet: string; key: string; cnt: number }[];
      const next: FacetCounts = { type: {}, age: {}, area: {} };
      for (const row of rows) {
        const bucket = row.facet === "type" ? next.type : row.facet === "age" ? next.age : next.area;
        bucket[row.key] = Number(row.cnt);
      }
      setResult({ key, counts: next });
    };
    const timer = setTimeout(run, FACETS_AFTER_MS);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Counts computed for other filters would mislabel these options.
  return key && result?.key === key ? result.counts : null;
}
