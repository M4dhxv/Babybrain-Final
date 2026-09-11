import { useEffect, useState, useSyncExternalStore } from 'react';
import { chunkLoadsInFlight, subscribeChunkLoads } from '@/lib/lazyRoute';
import { clearChunkReloadBudget } from '@/components/RouteErrorBoundary';

const SHOW_AFTER_MS = 150;
const SLOW_AFTER_MS = 6000;

const isLoading = () => chunkLoadsInFlight() > 0;

/** Router 7 keeps the old page on screen while a route chunk downloads, so this is the
 *  only sign a click registered; after a few seconds it offers a manual reload. */
export function ChunkProgress() {
  const loading = useSyncExternalStore(subscribeChunkLoads, isLoading, isLoading);
  const [stage, setStage] = useState<0 | 1 | 2>(0);

  useEffect(() => {
    if (!loading) return;
    const show = setTimeout(() => setStage(1), SHOW_AFTER_MS);
    const slow = setTimeout(() => setStage(2), SLOW_AFTER_MS);
    return () => {
      clearTimeout(show);
      clearTimeout(slow);
      setStage(0);
    };
  }, [loading]);

  if (!loading || stage === 0) return null;

  return (
    <>
      <div
        role="progressbar"
        aria-label="Loading page"
        className="fixed inset-x-0 top-0 z-[100] h-[3px] overflow-hidden bg-pink-100"
      >
        <div className="bb-chunk-bar h-full w-1/3 bg-[#FA4D8D]" />
      </div>
      {stage === 2 && (
        <div
          role="status"
          className="fixed left-1/2 top-3 z-[100] flex -translate-x-1/2 items-center gap-3 rounded-full bg-white px-4 py-2 text-sm text-gray-700 shadow-lg ring-1 ring-gray-200"
        >
          Still loading this page…
          <button
            type="button"
            onClick={() => {
              clearChunkReloadBudget();
              window.location.reload();
            }}
            className="font-semibold text-[#FA4D8D] hover:underline"
          >
            Reload
          </button>
        </div>
      )}
    </>
  );
}
