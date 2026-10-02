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
  let e = store.get(key);
  if (!e && isPersisted(key)) {
    // A hard refresh wipes the Map; the dashboard is the landing page, so its
    // last result is kept in localStorage and hydrated here. Still always
    // followed by a live refetch, so it is only ever shown a beat early.
    try {
      const raw = localStorage.getItem(PERSIST_PREFIX + key);
      if (raw) {
        const parsed = JSON.parse(raw) as Entry;
        if (typeof parsed.ts === 'number' && Date.now() - parsed.ts <= PERSIST_CAP_MS) {
          e = parsed;
          store.set(key, parsed);
        }
      }
    } catch { /* storage blocked or corrupt — behave as a miss */ }
  }
  if (!e) return undefined;
  const age = Date.now() - e.ts;
  if (age > (isPersisted(key) ? PERSIST_CAP_MS : HARD_CAP_MS)) {
    store.delete(key);
    return undefined;
  }
  return { data: e.data as T, age };
}

export function cacheSet(key: string, data: unknown): void {
  const entry = { data, ts: Date.now() };
  store.set(key, entry);
  if (isPersisted(key)) {
    try { localStorage.setItem(PERSIST_PREFIX + key, JSON.stringify(entry)); } catch { /* quota / blocked — in-memory copy still works */ }
  }
}

/** Keys that survive a hard refresh (display-only, always revalidated). */
const PERSIST_PREFIX = 'bb:vq:';
const PERSIST_CAP_MS = 6 * 60 * 60_000;
const isPersisted = (key: string) => key.startsWith('dashboard:');

/** Drop entries whose key starts with `prefix` (or everything when omitted).
 *  Called on sign-out so the next account on this browser starts clean. */
export function cacheInvalidate(prefix?: string): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k?.startsWith(PERSIST_PREFIX) && (prefix == null || k.slice(PERSIST_PREFIX.length).startsWith(prefix))) localStorage.removeItem(k);
    }
  } catch { /* ignore */ }
  if (prefix == null) {
    store.clear();
    return;
  }
  for (const k of [...store.keys()]) {
    if (k.startsWith(prefix)) store.delete(k);
  }
}
