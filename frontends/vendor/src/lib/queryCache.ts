/**
 * A tiny in-memory read cache with stale-while-revalidate semantics — the
 * vendor-portal twin of the parent app's `lib/queryCache.ts`.
 *
 * The portal is a HashRouter SPA: changing tab unmounts the page and its data
 * effects, so Dashboard → Bookings → Dashboard used to refetch everything from
 * scratch behind a full-bleed loader. This lets a read hook hand back the last
 * result instantly and refresh it in the background, so a tab you've already
 * visited reappears populated.
 *
 * Deliberately ~1 file: a module-level Map, no provider, no dependency. It is
 * NOT a React Query replacement — no invalidation graph, no pagination helpers.
 * Entries are only ever read back by the same hook that wrote them, and every
 * read is always followed by a live refetch, so a stale value is only ever
 * *shown a beat early*, never trusted as final.
 */

interface Entry {
  data: unknown;
  ts: number;
}

const store = new Map<string, Entry>();

/** Longest a cached value may still be *shown* (instantly, before the refetch
 *  that always follows resolves). Past this it's treated as absent. */
const HARD_CAP_MS = 10 * 60_000;

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
  if (age > HARD_CAP_MS) {
    store.delete(key);
    return undefined;
  }
  return { data: e.data as T, age };
}

export function cacheSet(key: string, data: unknown): void {
  store.set(key, { data, ts: Date.now() });
}

/** Drop entries whose key starts with `prefix` (or everything when omitted).
 *  Called on sign-out so the next account on this browser starts clean. */
export function cacheInvalidate(prefix?: string): void {
  if (prefix == null) {
    store.clear();
    return;
  }
  for (const k of [...store.keys()]) {
    if (k.startsWith(prefix)) store.delete(k);
  }
}
