import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { AuthHeader } from '@/components/AuthHeader';
import SiteFooter from '@/components/SiteFooter';

/** Only the tail of the clip is the actual crying loop; skip the lead-in. */
const LOOP_FROM = 0.5;

/**
 * Branded 404 for the vendor portal. Reached by the router's `*` fallback —
 * an unknown hash route, or a Stripe/return URL that no longer maps to a page.
 * Same header + footer as every other public page so it never looks like the
 * bare Next.js error screen.
 */
export default function NotFoundPage() {
  const navigate = useNavigate();
  const video = `${import.meta.env.BASE_URL}assets/not-found-baby.mp4`;
  const videoRef = useRef<HTMLVideoElement>(null);

  // Keep playback inside the back half of the clip: clamp `currentTime` so the
  // lead-in never plays and each loop restarts from the mid-point, and make
  // sure it keeps playing after every seek.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    let stopped = false;
    const half = () => (Number.isFinite(v.duration) && v.duration > 0 ? v.duration * LOOP_FROM : 0);
    const ensure = () => {
      if (stopped) return;
      const s = half();
      if (s && v.currentTime < s) v.currentTime = s;
      if (v.paused) v.play().catch(() => {});
    };
    const onTick = () => {
      const s = half();
      // Pre-empt the native loop-to-0 well before the end, and snap back up if
      // it ever slips into the lead-in.
      if (s && (v.currentTime >= v.duration - 0.35 || v.currentTime < s - 0.05)) v.currentTime = s;
    };
    const events: [keyof HTMLMediaElementEventMap, () => void][] = [
      ['loadedmetadata', ensure],
      ['canplay', ensure],
      ['seeked', ensure],
      ['pause', ensure],
      ['timeupdate', onTick],
    ];
    events.forEach(([e, fn]) => v.addEventListener(e, fn));
    ensure();
    return () => {
      stopped = true;
      events.forEach(([e, fn]) => v.removeEventListener(e, fn));
    };
  }, []);

  return (
    <div className="flex min-h-screen flex-col bg-white">
      <AuthHeader />

      <main className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center">
        {/* The source clip is 1280x720 with the artwork letterboxed (black
            bars ~73px left / ~129px right) on a near-white canvas. Show the
            whole frame — nothing cropped, so the head is never clipped — lift
            the canvas to pure white with a brightness nudge so it is
            indistinguishable from the page, and lay a white strip over each
            black bar. No border, no crop. */}
        <div className="relative w-full max-w-[540px] px-1 pt-2">
          <video
            ref={videoRef}
            src={video}
            autoPlay
            loop
            muted
            playsInline
            aria-label="A sad little one — this page could not be found"
            className="block h-auto w-full [filter:brightness(1.05)_saturate(1.04)]"
          />
          <span className="pointer-events-none absolute inset-y-0 left-0 w-[8%] bg-white" />
          <span className="pointer-events-none absolute inset-y-0 right-0 w-[12%] bg-white" />
        </div>

        <h1 className="mt-8 text-4xl font-bold text-[#111A4C] sm:text-5xl">404</h1>
        <p className="mt-2 text-lg font-semibold text-gray-700">This page could not be found.</p>
        <p className="mt-1 max-w-md text-sm text-gray-500">
          The link may be old or mistyped. Let&rsquo;s get you back to somewhere that exists.
        </p>

        <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
          <Button onClick={() => navigate('/')} className="rounded-full px-6">
            Back to home
          </Button>
          <Button
            variant="outline"
            onClick={() => navigate('/dashboard')}
            className="rounded-full border-blue-300 px-6 text-blue-700 hover:bg-blue-50"
          >
            Go to dashboard
          </Button>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
