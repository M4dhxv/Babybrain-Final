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

/** Drop entries whose key starts with `prefix` (or everything when omitted). */
export function cacheInvalidate(prefix?: string): void {
  if (prefix == null) {
    store.clear();
    return;
  }
  for (const k of [...store.keys()]) {
    if (k.startsWith(prefix)) store.delete(k);
  }
}
