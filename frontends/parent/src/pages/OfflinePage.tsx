import { useState } from "react";

/** Wifi-off glyph — inlined rather than added to ui.tsx's shared Icon set,
 *  same call as InstallBanner.tsx makes for its one-off Share icon: this is
 *  the only place it's used. */
function WifiOffIcon({ className = "h-10 w-10" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 2l20 20" />
      <path d="M8.5 16.5a5 5 0 0 1 7 0" />
      <path d="M5 12.5a10 10 0 0 1 5.5-3.5M19 12.5a10 10 0 0 0-3.5-2.9" />
      <path d="M1.5 8.5a15 15 0 0 1 4-2.8M22.5 8.5a15 15 0 0 0-8-4.3" />
      <path d="M12 20h.01" />
    </svg>
  );
}

/**
 * Full takeover shown in place of the app whenever the browser reports no
 * network (see App.tsx — mounted ahead of everything else, including the
 * install banner and pull-to-refresh, neither of which mean anything
 * offline). There's no service worker or offline cache in this app (see
 * styles/index.css's overscroll comment and index.html's boot watchdog for
 * the other places that gap already mattered), so this can't offer cached
 * content — it's honest about that instead of showing a broken half-loaded
 * page.
 *
 * `navigator.onLine` flipping back to true isn't trusted on its own (a
 * captive portal reports "online" with no real route out) — "Try again"
 * does one real fetch against the app's own manifest before dismissing.
 * Whether to mount this at all is entirely App.tsx's call (its own
 * `useOnline()`) — this component doesn't re-check online state itself, so
 * there's exactly one source of truth for the decision instead of two hook
 * instances that could disagree.
 */
export function OfflinePage() {
  const [checking, setChecking] = useState(false);
  const [justFailed, setJustFailed] = useState(false);

  async function tryAgain() {
    setChecking(true);
    setJustFailed(false);
    try {
      await fetch(`${import.meta.env.BASE_URL}manifest.webmanifest`, { cache: "no-store", mode: "same-origin" });
      // A real response came back, but the `online` event may not have fired
      // yet (some browsers lag) — a full reload is the simplest way to land
      // back in the app with fresh data rather than guessing at what's stale.
      window.location.reload();
    } catch {
      setJustFailed(true);
      setChecking(false);
    }
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-0 z-[2147483647] flex flex-col items-center justify-center gap-5 bg-baby-paper px-8 text-center"
    >
      <img
        src={`${import.meta.env.BASE_URL}assets/brand/logo-icon.png`}
        alt=""
        width={64}
        height={64}
        className="h-16 w-16 opacity-90"
      />
      <span className="grid h-16 w-16 place-items-center rounded-full bg-[#FEEBF2] text-baby-cta">
        <WifiOffIcon />
      </span>
      <div>
        <h1 className="text-xl font-black text-baby-ink">No internet connection</h1>
        <p className="mt-2 max-w-xs text-sm font-semibold leading-6 text-[#68718f]">
          BabyBrain needs a connection to load classes and bookings. Check your wifi or mobile data, then try again.
        </p>
      </div>
      <button
        type="button"
        onClick={tryAgain}
        disabled={checking}
        className={`rounded-[12px] bg-baby-cta px-6 py-3 text-[15px] font-black text-white shadow-pink transition hover:brightness-105 ${checking ? "opacity-60" : ""}`}
      >
        {checking ? "Checking…" : "Try again"}
      </button>
      {justFailed && (
        <p className="text-xs font-bold text-baby-cta">Still no connection — give it a moment and try again.</p>
      )}
    </div>
  );
}
