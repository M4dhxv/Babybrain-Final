import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

/** Shared by the pages a Notifications entry opens (Reviews, Make-up tokens).
 *  Reads `?<param>=<id>` once, and when `ready` (the list has rendered) scrolls
 *  to the element with `id="dl-<id>"`, returns that id for ~4s so the row can
 *  show a highlight ring, and drops the param from the URL. If the row isn't
 *  on screen it first calls `resetFilters` (back to the page's default view)
 *  and tries once more; if it's still missing (deleted) it gives up quietly.
 *  After that the vendor is free to change the filters as they like. */
export function useDeepLinkHighlight(param: string, ready: boolean, resetFilters: () => void): string | null {
  const [searchParams, setSearchParams] = useSearchParams();
  const pending = useRef<string | null>(searchParams.get(param));
  const [highlight, setHighlight] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const id = pending.current;
    if (!id || !ready) return;
    const el = document.getElementById(`dl-${id}`);
    if (!el && attempt === 0) {
      resetFilters();
      setAttempt(1);
      return;
    }
    pending.current = null;
    setSearchParams((prev) => { const next = new URLSearchParams(prev); next.delete(param); return next; }, { replace: true });
    if (!el) return;
    setHighlight(id);
    requestAnimationFrame(() => el.scrollIntoView({ block: 'center', behavior: 'smooth' }));
    const t = window.setTimeout(() => setHighlight(null), 4000);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, attempt]);

  return highlight;
}
