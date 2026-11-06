import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cacheGet, cacheSet } from "./queryCache";
import { withCooldown } from "./retry";
import { catalogRpc, reportCatalogFailure } from "./catalog";
import { toLiveActivity, type FacetCounts, type LiveActivity, type SearchRow } from "./useActivities";
import { AGE_BANDS } from "../data/content";
import type { SortOption } from "./database.types";

/**
 * Explore's data, redesigned for reliability (Nov 2026).
 *
 * The catalogue is small (tens of activities), so Explore no longer asks the
 * database a new question for every filter tap. It fetches the WHOLE matching
 * catalogue once, as a "snapshot", and narrows it on the phone:
 *
 *   server query (one snapshot each)     applied on the phone, instantly
 *   ───────────────────────────────      ───────────────────────────────
 *   text search (fuzzy, in Postgres)     Type (categories)
 *   date range, time of day              Age
 *   sort order + location                Area (regions)
 *                                        Price
 *                                        the Type/Age/Area option counts
 *                                        the map pins (the same rows)
 *
 * What stays on the server is exactly what only Postgres can do (text ranking,
 * session dates and times, ordering). Everything on the right is a plain
 * property of a row, filtered here with the SAME rules as matching_activities
 * (see `passes`); filtering an ordered list keeps its order, so the result is
 * identical to asking the database. scripts/explore-parity.mjs proves it
 * against the live catalogue.
 *
 * Why this is more reliable than before:
 *  - A Type/Age/Area/Price tap makes ZERO requests, so it cannot fail or wait.
 *  - The default view is the same URL for every parent, so the edge serves it
 *    from cache and the database is almost never touched.
 *  - One request replaces the three (list + map pins + option counts).
 *  - Once a parent holds a snapshot, a failed refresh is silent: they keep the
 *    list they have. The error banner only appears when there is nothing at all.
 *  - A failure with nothing to show retries itself (when the connection comes
 *    back, the tab returns, and on a gentle timer) instead of waiting for a tap.
 */

/** Rows asked for per request; a snapshot larger than this is read in pages. */
const PAGE = 500;
/** Safety stop: never loop forever if the count and the rows disagree. */
const MAX_ROWS = 3000;
/** A snapshot younger than this is used as is, with no request at all. */
const FRESH_MS = 60_000;
/** A burst of server-side changes (typing a search, dragging the time slider)
 *  costs one request, not one per keystroke. The first load is never delayed. */
const SETTLE_MS = 250;
/** When there is nothing to show and the load failed: try again by itself. */
const AUTO_RETRY_MS = [4_000, 10_000, 25_000];

/** What only the database can decide. Part of the snapshot's cache key. */
export interface ExploreServerQuery {
  query?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  timeMin?: number | null;
  timeMax?: number | null;
  sort?: SortOption;
  /** For sort "distance": where the parent is (or an area's centre). */
  lat?: number | null;
  lng?: number | null;
  /** Areas nearest-first, when `lat`/`lng` is only an area's centre. */
  regionOrder?: string[] | null;
}

/** What the phone decides, with no request. */
export interface ExploreFilters {
  categories: string[];
  ageMinMonths: number | null;
  ageMaxMonths: number | null;
  regions: string[];
  maxPrice: number | null;
}

type Snapshot = { rows: SearchRow[] };

/** Everything that decides which rows the snapshot holds, and in what order. */
function serverArgs(q: ExploreServerQuery) {
  return {
    p_query: q.query ?? null,
    p_date_from: q.dateFrom || null,
    p_date_to: q.dateTo || null,
    p_time_min: q.timeMin ?? null,
    p_time_max: q.timeMax ?? null,
    p_sort: q.sort ?? "soonest",
    // ~1 km grid: parents a street apart share one cached answer.
    p_lat: q.lat != null ? Math.round(q.lat * 100) / 100 : null,
    p_lng: q.lng != null ? Math.round(q.lng * 100) / 100 : null,
    // Only sent when set: a database that hasn't had migration 00220 yet
    // rejects an argument it doesn't know, even a null one.
    ...(q.regionOrder?.length ? { p_region_order: q.regionOrder } : {}),
  };
}

const snapshotKey = (q: ExploreServerQuery) => "activities:explore2:" + JSON.stringify(serverArgs(q));

/**
 * The same rules as matching_activities (migration 00265), one per filter.
 * `skip` leaves one filter out, which is how an option's count is "how many
 * would match if I also picked this" (search_activity_facets).
 */
function passes(r: SearchRow, f: ExploreFilters, skip?: "type" | "age" | "area"): boolean {
  if (skip !== "type" && f.categories.length) {
    const hit = (r.category_slug != null && f.categories.includes(r.category_slug))
      || (r.category_2_slug != null && f.categories.includes(r.category_2_slug));
    if (!hit) return false;
  }
  if (skip !== "age" && f.ageMinMonths != null && f.ageMaxMonths != null) {
    if (!(r.age_min_months <= f.ageMaxMonths && r.age_max_months >= f.ageMinMonths)) return false;
  }
  if (skip !== "area" && f.regions.length) {
    // A private session at the customer's own home has no fixed area and
    // satisfies every area filter (migration 00175).
    const hit = !!r.is_custom_location || (r.areas ?? []).some((a) => f.regions.includes(a));
    if (!hit) return false;
  }
  if (f.maxPrice != null) {
    const lo = r.price_from ?? r.price;
    if (lo != null && Number(lo) > f.maxPrice) return false;
  }
  return true;
}

function countFacets(rows: SearchRow[], f: ExploreFilters): FacetCounts {
  // The database always reports the "custom" (at-home) area, even as 0.
  const out: FacetCounts = { type: {}, age: {}, area: { custom: 0 } };
  for (const r of rows) {
    if (passes(r, f, "type")) {
      for (const k of new Set([r.category_slug, r.category_2_slug])) if (k) out.type[k] = (out.type[k] ?? 0) + 1;
    }
    if (passes(r, f, "age")) {
      for (const b of AGE_BANDS) {
        if (r.age_min_months <= b.max && r.age_max_months >= b.min) out.age[b.key] = (out.age[b.key] ?? 0) + 1;
      }
    }
    if (passes(r, f, "area")) {
      for (const a of r.areas ?? []) out.area[a] = (out.area[a] ?? 0) + 1;
      if (r.is_custom_location) out.area.custom += 1;
    }
  }
  return out;
}

type RpcRow = SearchRow & { id: string; total_count: number | null };

/** The whole matching catalogue: one request normally, more only if it is huge. */
async function fetchSnapshot(
  args: ReturnType<typeof serverArgs>,
  signal: AbortSignal,
): Promise<{ data: Snapshot | null; error: unknown }> {
  const rows: RpcRow[] = [];
  const seen = new Set<string>();
  while (rows.length < MAX_ROWS) {
    const { data, error } = await catalogRpc("search_activities", { ...args, p_limit: PAGE, p_offset: rows.length }, signal);
    if (error) return { data: null, error };
    const batch = (data ?? []) as RpcRow[];
    const before = rows.length;
    for (const r of batch) if (!seen.has(r.id)) { seen.add(r.id); rows.push(r); }
    const total = Number(batch[0]?.total_count ?? rows.length);
    if (batch.length < PAGE || rows.length >= total || rows.length === before) break;
  }
  return { data: { rows }, error: null };
}

/** Pre-load Explore's default snapshot on idle, so opening Explore after hours
 *  away shows real cards at once. Gentle: one request, only when the held copy
 *  is missing or old, never on a data-saver connection or a hidden tab; silent
 *  on failure (Explore simply loads as it always did). */
const WARM_SKIP_MS = 5 * 60_000;
let warming = false;
export async function warmExploreCatalogue(sort: SortOption): Promise<void> {
  if (warming || typeof document === "undefined" || document.visibilityState !== "visible") return;
  // Already on Explore: the page is loading this very snapshot itself.
  if (location.pathname.split("/").includes("explore")) return;
  const conn = (navigator as unknown as { connection?: { saveData?: boolean } }).connection;
  if (conn?.saveData) return;
  const q: ExploreServerQuery = { sort };
  const key = snapshotKey(q);
  const cached = cacheGet<Snapshot>(key);
  if (cached && cached.age < WARM_SKIP_MS) return;
  warming = true;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12_000);
  try {
    const { data } = await fetchSnapshot(serverArgs(q), ctl.signal);
    if (data) cacheSet(key, data);
  } catch {
    /* best effort */
  } finally {
    clearTimeout(timer);
    warming = false;
  }
}

export function useExploreCatalogue(server: ExploreServerQuery, filters: ExploreFilters, facetsEnabled: boolean) {
  const key = snapshotKey(server);
  const cachedNow = cacheGet<Snapshot>(key);

  // `fetched` is only ever trusted when it was fetched for this exact key.
  const [fetched, setFetched] = useState<{ key: string; snap: Snapshot } | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  const snap: Snapshot | null = fetched?.key === key ? fetched.snap : cachedNow?.data ?? null;
  // An error is only ever "nothing to show". A refresh that fails while the
  // parent already holds a list stays silent (it is still reported below).
  const error = !snap && failedKey === key;
  const loading = !snap && !error;

  const firstRun = useRef(true);
  const autoTries = useRef(0);
  useEffect(() => {
    const ctl = new AbortController();
    const immediate = firstRun.current;
    firstRun.current = false;
    const cached = cacheGet<Snapshot>(key);
    if (cached && cached.age < FRESH_MS && attempt === 0) return; // fresh enough — no network at all
    setFailedKey(null);

    const run = async () => {
      const { data, error: rpcError } = await withCooldown((signal) => fetchSnapshot(serverArgs(server), signal), {
        signal: ctl.signal,
        budgetMs: 20_000,
        timeoutMs: 10_000,
      });
      if (ctl.signal.aborted) return;
      if (rpcError || !data) {
        reportCatalogFailure(cached ? "list-background" : "list", rpcError);
        setFailedKey(key); // never cached
        return;
      }
      autoTries.current = 0;
      cacheSet(key, data);
      setFetched({ key, snap: data });
    };
    const timer = setTimeout(run, immediate || attempt > 0 ? 0 : SETTLE_MS);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt]);

  // Nothing to show and the load failed: try again by itself — when the
  // connection returns, when the tab comes back to the front, and a few times
  // on a timer — so a parent on a flaky signal is not left holding a button.
  useEffect(() => {
    if (!error) return;
    const retryNow = () => {
      if (document.visibilityState === "visible" && navigator.onLine !== false) reload();
    };
    window.addEventListener("online", retryNow);
    document.addEventListener("visibilitychange", retryNow);
    const wait = AUTO_RETRY_MS[autoTries.current];
    const timer = wait == null ? undefined : window.setTimeout(() => { autoTries.current += 1; retryNow(); }, wait);
    return () => {
      window.removeEventListener("online", retryNow);
      document.removeEventListener("visibilitychange", retryNow);
      if (timer) clearTimeout(timer);
    };
  }, [error, reload]);

  // Map each row once per snapshot; filtering below only picks from this.
  const mapped = useMemo(() => (snap ? snap.rows.map((row) => ({ row, activity: toLiveActivity(row) })) : []), [snap]);

  const filterKey = JSON.stringify(filters);
  const activities: LiveActivity[] = useMemo(
    () => mapped.filter((m) => passes(m.row, filters)).map((m) => m.activity),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mapped, filterKey],
  );
  const facets: FacetCounts | null = useMemo(
    () => (facetsEnabled && snap ? countFacets(snap.rows, filters) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snap, filterKey, facetsEnabled],
  );

  return { activities, total: activities.length, loading, error, reload, facets };
}
