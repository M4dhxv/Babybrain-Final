import { useEffect, useRef, useState } from "react";

// How far down (px) the parent has to drag before letting go triggers a
// refresh, and the visual cap on the pull indicator itself.
const THRESHOLD = 64;
const MAX_PULL = 90;
// Below this much combined movement, a gesture is too small to call either
// way yet — a finger settling before a swipe reads as a few px of jitter,
// not a direction. Past it, whichever axis moved more decides: horizontal
// (or diagonal-leaning-horizontal, the >1.5x margin the hero carousel's own
// swipe uses) hands the gesture to whatever's underneath — a carousel swipe,
// say — instead of being read as the start of a pull.
const DEAD_ZONE = 10;

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
  const startX = useRef(0);

  useEffect(() => {
    if (refreshing) return;
    const onStart = (e: TouchEvent) => {
      const eligible = !overlayOpen() && window.scrollY <= 0 && e.touches.length === 1;
      startY.current = eligible ? e.touches[0].clientY : null;
      startX.current = e.touches[0]?.clientX ?? 0;
    };
    const onMove = (e: TouchEvent) => {
      if (startY.current == null) return;
      // The page may have scrolled since the gesture started (a momentum
      // flick still settling) — bail rather than pull from mid-page.
      if (window.scrollY > 0) { startY.current = null; setPull(0); return; }
      const delta = e.touches[0].clientY - startY.current;
      const deltaX = e.touches[0].clientX - startX.current;
      // Too small yet to call a direction — wait for more movement rather
      // than committing to "pull" on the first pixel of what might turn out
      // to be a horizontal swipe.
      if (Math.abs(deltaX) < DEAD_ZONE && Math.abs(delta) < DEAD_ZONE) return;
      // Decided once: a swipe that's mostly sideways (the hero carousel, an
      // open gallery) hands off to whatever's underneath for the rest of
      // this touch, rather than re-deciding every move and flip-flopping.
      if (delta < Math.abs(deltaX) * 1.5) { startY.current = null; setPull(0); return; }
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
  // Circle is r=9, so its full circumference is 2π×9 ≈ 56.5 — the arc's
  // stroke-dasharray fills that proportionally to how far through the pull
  // the parent is, same one-ui-style "the ring draws itself in" feel.
  const progress = Math.min(pull / THRESHOLD, 1);
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-x-0 top-2 z-50 flex justify-center transition-transform duration-150 ease-out"
      style={{ transform: `translateY(${offset}px)` }}
    >
      <div
        className="grid h-[52px] w-[52px] place-items-center rounded-full bg-white"
        style={{ boxShadow: "0 6px 16px rgba(17,26,76,0.16), 0 2px 4px rgba(17,26,76,0.08)" }}
      >
        <svg viewBox="0 0 24 24" className="h-[26px] w-[26px]" fill="none">
          <circle cx="12" cy="12" r="9" stroke="#EDF6FD" strokeWidth="3" />
          {refreshing ? (
            <path d="M12 3a9 9 0 0 1 9 9" stroke="#4597F7" strokeWidth="3" strokeLinecap="round" className="origin-center animate-spin" />
          ) : (
            <circle
              cx="12"
              cy="12"
              r="9"
              stroke="#4597F7"
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray={`${progress * 56.5} 56.5`}
              className="origin-center -rotate-90"
            />
          )}
        </svg>
      </div>
    </div>
  );
}
