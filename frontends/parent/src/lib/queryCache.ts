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
