import { useEffect, useState } from "react";
import { Icon } from "./ui";
import {
  CLOSE_MS,
  NOT_NOW_MS,
  countActivityView,
  countVisit,
  hasEngaged,
  isSnoozed,
  promptInstall,
  snoozeInstall,
  useInstallState,
} from "../lib/install";

// Pages where a banner would get in the way (sign-in, sign-up, checkout).
const QUIET_ROUTES = new Set(["/login", "/forgot-password", "/reset-password", "/onboarding", "/book", "/booked", "/payment"]);

/** Any full-screen overlay (the email sign-up popup, the photo viewer) is up. */
const overlayOpen = () => !!document.querySelector("div.fixed.inset-0");

// "Install the app" only makes sense as a phone gesture — a desktop browser
// already has its own install affordance (the icon in Chrome/Edge's address
// bar) when `beforeinstallprompt` fires, so this banner used to also pop up
// over desktop Chrome/Edge sessions promoting something the browser was
// already offering. `pointer: coarse` is touch-primary (phones/tablets), the
// same check ExploreMap.tsx uses to tell a touchscreen from a mouse.
const isMobileBrowser = () =>
  typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;

/**
 * Invites parents to install the site as an app.
 *
 * Shows a card with an Install button that opens the browser's own install dialog (Android /
 * desktop Chrome and Edge), or the "Share → Add to Home Screen" steps on iPhone Safari. It waits
 * until the parent has come back (second visit) or looked at an activity, never sits on top of
 * another popup, and stays out of the way of sign-in and checkout. "Not now" hides it for 5 days,
 * the cross for 24 hours.
 */
export function InstallBanner({ pathname }: { pathname: string }) {
  const state = useInstallState();
  const [open, setOpen] = useState(false);

  // Bookkeeping for the "second visit / viewed an activity" rule.
  useEffect(() => { countVisit(); }, []);
  useEffect(() => { if (pathname === "/activity") countActivityView(); }, [pathname]);

  const installable = !state.installed && (state.native || state.ios);
  const eligible =
    installable && !QUIET_ROUTES.has(pathname) && isMobileBrowser() && (state.forced || (hasEngaged() && !isSnoozed()));

  useEffect(() => {
    if (!eligible) { setOpen(false); return; }
    // A short pause so it doesn't jump in with the page, and a check that no popup is showing.
    const t = window.setInterval(() => {
      if (!overlayOpen()) { setOpen(true); window.clearInterval(t); }
    }, 1500);
    return () => window.clearInterval(t);
  }, [eligible]);

  if (!open || !eligible) return null;

  const notNow = () => { setOpen(false); snoozeInstall(NOT_NOW_MS); };
  const close = () => { setOpen(false); snoozeInstall(CLOSE_MS); };
  const install = async () => {
    setOpen(false);
    const accepted = await promptInstall();
    if (!accepted) snoozeInstall(NOT_NOW_MS); // cancelled the browser's dialog: treat as "Not now"
  };

  return (
    <div
      role="dialog"
      aria-label="Install BabyBrain"
      className="fixed inset-x-3 z-40 mx-auto max-w-md rounded-[20px] border border-[#EBE3E5] bg-white p-4 shadow-soft"
      style={{ bottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}
    >
      {/* Thick cross, no box. */}
      <button
        type="button"
        onClick={close}
        aria-label="Close"
        className="absolute right-2.5 top-2.5 p-1.5 text-[#59658d] hover:text-baby-ink"
      >
        <Icon name="close" className="h-5 w-5" strokeWidth={3.2} />
      </button>

      <div className="flex items-center gap-3 pr-9">
        <img src="/app/assets/brand/icon-192.png" alt="" width={44} height={44} className="h-11 w-11 shrink-0 rounded-[12px]" />
        <h2 className="text-[17px] font-black leading-tight text-baby-ink">Upgrade your experience ✨</h2>
      </div>

      {state.native ? (
        <>
          <p className="mt-2 text-sm font-semibold leading-5 text-[#59658d]">
            Add BabyBrain to your home screen. One tap to find and book classes near you, full screen, no browser bars.
          </p>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {["Opens in one tap", "Full screen", "Always up to date"].map((t) => (
              <span key={t} className="rounded-full bg-palette-pinkTint px-2.5 py-1 text-[11px] font-black text-baby-cta">{t}</span>
            ))}
          </div>
          <button
            type="button"
            onClick={install}
            className="mt-3.5 w-full rounded-[12px] bg-baby-cta py-3 text-[15px] font-black text-white shadow-pink transition hover:brightness-105"
          >
            Install app
          </button>
        </>
      ) : (
        <>
          <p className="mt-2 text-sm font-semibold leading-5 text-[#59658d]">Add BabyBrain to your home screen in three taps:</p>
          <ol className="mt-2.5 space-y-2 text-sm font-semibold text-baby-ink">
            <li className="flex items-center gap-2.5">
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-palette-pinkTint text-xs font-black text-baby-cta">1</span>
              <span className="flex items-center gap-1.5">
                Tap the Share button
                <svg viewBox="0 0 24 24" className="h-5 w-5 text-baby-cta" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 3v12M8 7l4-4 4 4M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1" />
                </svg>
              </span>
            </li>
            <li className="flex items-center gap-2.5">
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-palette-pinkTint text-xs font-black text-baby-cta">2</span>
              <span>Choose <b className="font-black">Add to Home Screen</b></span>
            </li>
            <li className="flex items-center gap-2.5">
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-palette-pinkTint text-xs font-black text-baby-cta">3</span>
              <span>Tap <b className="font-black">Add</b></span>
            </li>
          </ol>
        </>
      )}

      <button type="button" onClick={notNow} className="mt-2 w-full py-1.5 text-center text-[13px] font-bold text-[#68718f] hover:text-baby-ink">
        Not now
      </button>
    </div>
  );
}
