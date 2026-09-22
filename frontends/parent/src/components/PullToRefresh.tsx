import { useEffect, useRef, useState } from "react";

// How far down (px) the parent has to drag before letting go triggers a
// refresh, and the visual cap on the pull indicator itself.
const THRESHOLD = 64;
const MAX_PULL = 90;

/** Same check InstallBanner.tsx uses: any full-screen overlay (photo viewer,
 *  email sign-up popup) is up, so a drag inside it shouldn't be read as a
 *  pull-to-refresh on the page underneath. */
const overlayOpen = () => !!document.querySelector("div.fixed.inset-0");

/**
 * A stand-in "slide to refresh" gesture. The browser's own pull-to-refresh
 * is deliberately switched off site-wide (`overscroll-behavior-y: none` in
 * styles/index.css) because its rubber-band bounce dragged the sticky header
 * and fixed filter bar along with the page — but that CSS also silently took
 * pull-to-refresh itself away with nothing to replace it, which is the bug
 * this component fixes.
 *
 * Only engages when the page is already scrolled to the very top and the
 * parent drags down from there with one finger, so it never fights normal
 * scrolling, a horizontal photo-swipe, or a map drag.
 */
export function PullToRefresh() {
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const startY = useRef<number | null>(null);

  useEffect(() => {
    if (refreshing) return;
    const onStart = (e: TouchEvent) => {
      startY.current =
        !overlayOpen() && window.scrollY <= 0 && e.touches.length === 1 ? e.touches[0].clientY : null;
    };
    const onMove = (e: TouchEvent) => {
      if (startY.current == null) return;
      // The page may have scrolled since the gesture started (a momentum
      // flick still settling) — bail rather than pull from mid-page.
      if (window.scrollY > 0) { startY.current = null; setPull(0); return; }
      const delta = e.touches[0].clientY - startY.current;
      if (delta <= 0) { setPull(0); return; }
      // Resistance past the threshold, the same rubber-band feel native
      // pull-to-refresh has, so it doesn't just track the finger 1:1.
      const eased = delta < THRESHOLD ? delta : THRESHOLD + (delta - THRESHOLD) / 3;
      setPull(Math.min(eased, MAX_PULL));
      // Only once we're actually treating this as a pull — otherwise this
      // would block ordinary upward scrolling from the very top of the page.
      e.preventDefault();
    };
    const onEnd = () => {
      if (startY.current == null) return;
      startY.current = null;
      setPull((p) => {
        if (p >= THRESHOLD) {
          setRefreshing(true);
          window.location.reload();
        }
        return 0;
      });
    };
    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onEnd, { passive: true });
    document.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onEnd);
      document.removeEventListener("touchcancel", onEnd);
    };
  }, [refreshing]);

  if (pull <= 0 && !refreshing) return null;

  const offset = (refreshing ? 40 : pull) - 40;
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-x-0 top-2 z-50 flex justify-center transition-transform duration-150 ease-out"
      style={{ transform: `translateY(${offset}px)` }}
    >
      <div className="grid h-9 w-9 place-items-center rounded-full bg-white shadow-soft">
        <svg
          viewBox="0 0 24 24"
          className={`h-5 w-5 text-baby-cta ${refreshing ? "animate-spin" : ""}`}
          style={refreshing ? undefined : { transform: `rotate(${Math.min(pull / THRESHOLD, 1) * 180}deg)` }}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3 12a9 9 0 0 1 9-9c2.4 0 4.6 1 6.2 2.6M21 12a9 9 0 0 1-9 9c-2.4 0-4.6-1-6.2-2.6" />
          <path d="M21 3v6h-6M3 21v-6h6" />
        </svg>
      </div>
    </div>
  );
}
