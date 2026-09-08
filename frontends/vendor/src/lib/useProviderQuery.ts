import { useCallback, useEffect, useRef, useState } from 'react';
import { cacheGet, cacheSet } from './queryCache';

export interface ProviderQueryResult<T> {
  /** The freshest data we have — a cached value first, replaced in place when
   *  the live refetch resolves. `undefined` only before the first success. */
  data: T | undefined;
  /** True only when there is nothing to show yet (no cache hit and the first
   *  fetch is still in flight). Drives the skeleton. */
  loading: boolean;
  /** True when we already have data on screen and a background refetch is
   *  running. Drives a thin top progress bar, never a full loader. */
  refreshing: boolean;
  /** Set if the most recent fetch threw. Any previously-loaded `data` stays
   *  visible so a transient network blip never blanks the page. */
  error: unknown;
  /** Force a fresh fetch (e.g. after a mutation on the page). */
  refetch: () => void;
}

/**
 * Stale-while-revalidate read hook for the vendor portal.
 *
 * Pass a stable `key` (include the provider id and anything the query varies
 * on) and a `fetcher`. On mount it shows any cached value instantly, then
 * ALWAYS runs `fetcher` and swaps in the live result — so a revisited tab is
 * never blank, and what you end up looking at is always freshly fetched, never
 * a stale cache trusted as final. A `null` key means "not ready yet" (e.g. the
 * provider hasn't resolved): the hook just reports `loading` and fetches
 * nothing until a real key arrives.
 *
 * `fetcher` must throw on error (don't swallow to `null`), so a failed refresh
 * keeps the last good data on screen instead of replacing it with emptiness.
 */
export function useProviderQuery<T>(
  key: string | null,
  fetcher: () => Promise<T>,
): ProviderQueryResult<T> {
  const cached = key ? cacheGet<T>(key) : undefined;
  const [data, setData] = useState<T | undefined>(cached?.data);
  const [loading, setLoading] = useState<boolean>(!cached && !!key);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<unknown>(undefined);

  // Latest fetcher without retriggering the effect when a caller passes an
  // inline arrow (they almost always do).
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const runIdRef = useRef(0);
  const [manualNonce, setManualNonce] = useState(0);

  const refetch = useCallback(() => setManualNonce((n) => n + 1), []);

  useEffect(() => {
    if (!key) {
      setLoading(false);
      return;
    }

    const hit = cacheGet<T>(key);
    if (hit) {
      setData(hit.data);
      setLoading(false);
      setRefreshing(true);
    } else {
      setLoading(true);
      setRefreshing(false);
    }

    const runId = ++runIdRef.current;
    let alive = true;

    (async () => {
      try {
        const fresh = await fetcherRef.current();
        if (!alive || runId !== runIdRef.current) return;
        cacheSet(key, fresh);
        setData(fresh);
        setError(undefined);
      } catch (err) {
        if (!alive || runId !== runIdRef.current) return;
        // Keep whatever `data` we already had — a transient failure must not
        // blank a populated page.
        setError(err);
      } finally {
        if (alive && runId === runIdRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    })();

    return () => {
      alive = false;
    };
  }, [key, manualNonce]);

  return { data, loading, refreshing, error, refetch };
}
