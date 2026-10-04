/**
 * A tiny in-memory read cache with stale-while-revalidate semantics.
 *
 * Now that the parent app is a real SPA, changing route unmounts the page and
 * its data hooks — so navigating Explore → a listing → back used to refetch
 * everything from scratch. This lets the read hooks (`useActivities`,
 * `useRecommendations`, `useActivityDetail`) hand back the last result
 * instantly and refresh it in the background.
 *
 * Deliberately ~1 file: a module-level Map, no provider, no dependency. It is
 * not a React Query replacement — no query invalidation graph, no pagination
 * helpers. Entries are only ever read back by the same hook that wrote them.
 */

interface Entry {
  data: unknown;
  ts: number;
}

const store = new Map<string, Entry>();

/** Longest a cached value may still be *shown* (instantly, before any refetch
 *  resolves). Past this it's treated as absent. */
const HARD_CAP_MS = 10 * 60_000;

/* ---- Survives a restart (public, non-personal reads only) -------------------
 *
 * The in-memory store dies with the page, so the first open of an activity
 * after the app had been closed (or the OS had discarded it) always started
 * from nothing: skeleton until every request in the waterfall landed — the
 * "10+ seconds after a while". Listings, map pins and activity pages are the
 * same for every visitor, so they're mirrored to localStorage and come back
 * instantly on the next launch, then revalidate in the background exactly as
 * a warm in-memory hit does. Anything user-specific (profile:, recs, plan) is
 * never written. */
const PERSIST_PREFIXES = ["detail:", "activities:", "pins:", "facets:", "act-core:"];
const PERSIST_KEY = "bb-qc-v2";
/** How stale a persisted value may be and still be shown while it refreshes. */
const PERSIST_MAX_AGE_MS = 6 * 60 * 60_000;
/** Keep well inside localStorage's ~5 MB so we never crowd out the auth session. */
const PERSIST_MAX_BYTES = 1_200_000;

const isPersisted = (key: string) => PERSIST_PREFIXES.some((p) => key.startsWith(p));
const maxAge = (key: string) => (isPersisted(key) ? PERSIST_MAX_AGE_MS : HARD_CAP_MS);

// v1 may hold listings cached from failed requests (empty results); drop it.
try {
  if (typeof localStorage !== "undefined") localStorage.removeItem("bb-qc-v1");
} catch {
  /* storage blocked */
}

try {
  const raw = typeof localStorage !== "undefined" ? localStorage.getItem(PERSIST_KEY) : null;
  if (raw) {
    const saved = JSON.parse(raw) as Record<string, Entry>;
    const now = Date.now();
    for (const [k, e] of Object.entries(saved)) {
      if (isPersisted(k) && e && typeof e.ts === "number" && now - e.ts <= PERSIST_MAX_AGE_MS) store.set(k, e);
    }
  }
} catch {
  /* storage blocked or corrupt — start empty */
}

let persistTimer: number | undefined;
function schedulePersist() {
  if (typeof window === "undefined") return;
  window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    const write = () => {
      try {
        // Newest first, until the byte budget is spent.
        const entries = [...store.entries()].filter(([k]) => isPersisted(k)).sort((a, b) => b[1].ts - a[1].ts);
        const out: Record<string, Entry> = {};
        let bytes = 0;
        for (const [k, e] of entries) {
          const size = JSON.stringify(e).length + k.length;
          if (bytes + size > PERSIST_MAX_BYTES) continue;
          bytes += size;
          out[k] = e;
        }
        localStorage.setItem(PERSIST_KEY, JSON.stringify(out));
      } catch {
        /* quota or blocked storage — the in-memory cache still works */
      }
    };
    if ("requestIdleCallback" in window) (window as unknown as { requestIdleCallback: (cb: () => void) => void }).requestIdleCallback(write);
    else write();
  }, 1500);
}

export interface CacheHit<T> {
  data: T;
  /** Milliseconds since this entry was written. */
  age: number;
}

/** The cached value for `key`, or undefined if absent or older than HARD_CAP. */
export function cacheGet<T>(key: string): CacheHit<T> | undefined {
  const e = store.get(key);
  if (!e) return undefined;
  const age = Date.now() - e.ts;
  if (age > maxAge(key)) {
    store.delete(key);
    return undefined;
  }
  return { data: e.data as T, age };
}

export function cacheSet(key: string, data: unknown): void {
  store.set(key, { data, ts: Date.now() });
  if (isPersisted(key)) schedulePersist();
}

/** Drop entries whose key starts with `prefix` (or everything when omitted). */
export function cacheInvalidate(prefix?: string): void {
  if (prefix == null) {
    store.clear();
    schedulePersist();
    return;
  }
  for (const k of [...store.keys()]) {
    if (k.startsWith(prefix)) store.delete(k);
  }
  if (PERSIST_PREFIXES.some((p) => p.startsWith(prefix) || prefix.startsWith(p))) schedulePersist();
}

// Requests for the same key that are still in flight when a second caller
// asks for it — e.g. two components mounting in the same tick, or a fast
// back-and-forth nav — used to each fire their own network call, since
// cacheGet only knows about *resolved* entries. Tracked separately from
// `store` so a slow/failed fetch never blocks a later, independent one.
const inflight = new Map<string, Promise<unknown>>();

/**
 * `data` for `key` if it's fresher than `freshMs`; otherwise runs `fetcher`
 * once — even if called again for the same key before it resolves — caches
 * the result, and returns it. A stale (or absent) cache entry still resolves
 * immediately once the shared in-flight request lands.
 */
export async function cacheFetch<T>(key: string, freshMs: number, fetcher: () => PromiseLike<T>): Promise<T> {
  const hit = cacheGet<T>(key);
  if (hit && hit.age < freshMs) return hit.data;
  const pending = inflight.get(key) as Promise<T> | undefined;
  if (pending) return pending;
  const p = Promise.resolve(fetcher())
    .then((data) => {
      cacheSet(key, data);
      return data;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, p);
  return p;
}
