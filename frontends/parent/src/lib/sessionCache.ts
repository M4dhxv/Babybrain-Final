/**
 * A sessionStorage-backed cache for data that's effectively immutable for
 * the life of a browser tab — a parent's past/cancelled booking history,
 * say, which almost never changes once written. The shared in-memory
 * `queryCache` (lib/queryCache.ts) caps every entry at a 10-minute hard cap
 * regardless of the freshness window a caller asks for, since it's meant
 * for "don't refetch what a fast back-and-forth nav just fetched" — not
 * "never redo this expensive read again this session." Raising that cap
 * globally would change every page that uses it; this is a separate, opt-in
 * cache for the handful of reads that actually want to survive much longer.
 *
 * sessionStorage (not localStorage) so it clears itself when the tab closes
 * rather than silently serving another day's data on a later visit.
 */

export function sessionCacheGet<T>(key: string): T | undefined {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}

export function sessionCacheSet(key: string, data: unknown): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(data));
  } catch {
    // Storage full or disabled (private browsing) — the read just won't be
    // cached; never worth failing the caller over.
  }
}

/** Drop entries whose key starts with `prefix`. Called alongside the shared
 *  cache's own invalidation, so the two never drift out of sync. */
export function sessionCacheInvalidate(prefix: string): void {
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i);
      if (k && k.startsWith(prefix)) sessionStorage.removeItem(k);
    }
  } catch {
    // ignore
  }
}
