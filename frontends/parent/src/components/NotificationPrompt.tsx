import { useEffect, useState } from "react";
import { Icon } from "./ui";
import { useAuth } from "../auth/AuthProvider";
import {
  PUSH_CLOSE_MS,
  PUSH_NOT_NOW_MS,
  isPushSnoozed,
  loadPushConfig,
  pushAvailable,
  pushPermission,
  setPushPromptWanted,
  snoozePush,
  subscribeToPush,
  syncPushSubscription,
  usePushServerEnabled,
} from "../lib/push";

// Pages where a popup would get in the way (sign-in, sign-up, checkout).
// /booked is deliberately NOT here: right after a booking is when "tell me about this" matters most.
const QUIET_ROUTES = new Set(["/login", "/forgot-password", "/reset-password", "/onboarding", "/book", "/payment"]);

/** Any full-screen overlay (the email sign-up popup, the photo viewer) is up. */
const overlayOpen = () => !!document.querySelector("div.fixed.inset-0");

/**
 * Asks signed-in parents to turn on notifications, ahead of the install banner
 * and whether or not the app is installed.
 *
 * It is a soft prompt, not the browser's own: the browser only gets asked when
 * the parent taps "Turn on notifications" (Safari requires a tap, and a cold
 * browser prompt is the quickest way to get "Block" for good). "Not now" hides it
 * for 3 days, the cross for 24 hours; Settings → Notifications always works.
 *
 * iPhone / iPad can only be asked once the app is installed (iOS exposes push to
 * Home Screen apps only), so there this simply appears on the installed app's
 * first launch. If permission was already granted — an earlier visit, or another
 * account on this device — it quietly re-attaches this device to whoever is
 * signed in.
 */
export function NotificationPrompt({ pathname }: { pathname: string }) {
  const { session } = useAuth();
  const userId = session?.user.id ?? null;
  const [dismissed, setDismissed] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (userId) void syncPushSubscription(userId);
  }, [userId]);

  // Only once the server confirms the VAPID variables are set: otherwise a
  // parent would be asked for a permission nothing can use yet.
  const serverEnabled = usePushServerEnabled();
  useEffect(() => { void loadPushConfig(); }, []);

  const due =
    !!userId && serverEnabled && !dismissed && pushAvailable() && pushPermission() === "default" && !isPushSnoozed();
  const eligible = due && !QUIET_ROUTES.has(pathname);

  // Held for as long as it is due, so the install banner waits its turn.
  useEffect(() => {
    setPushPromptWanted(due);
    return () => setPushPromptWanted(false);
  }, [due]);

  useEffect(() => {
    if (!eligible) { setOpen(false); return; }
    // A short pause so it doesn't jump in with the page, and a check that no popup is showing.
    const t = window.setInterval(() => {
      if (!overlayOpen()) { setOpen(true); window.clearInterval(t); }
    }, 1500);
    return () => window.clearInterval(t);
  }, [eligible]);

  if (!open || !eligible) return null;

  const notNow = () => { snoozePush(PUSH_NOT_NOW_MS); setDismissed(true); setOpen(false); };
  const close = () => { snoozePush(PUSH_CLOSE_MS); setDismissed(true); setOpen(false); };
  const turnOn = async () => {
    setBusy(true);
    setError(null);
    try {
      const state = await subscribeToPush();
      if (state === "subscribed") { setDismissed(true); setOpen(false); return; }
      // Blocked, or the browser's own dialog was closed without an answer.
      snoozePush(PUSH_NOT_NOW_MS);
      setDismissed(true);
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't turn on notifications — try again in Settings.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-label="Turn on notifications"
      className="fixed inset-x-3 z-40 mx-auto max-w-md rounded-[20px] border border-[#EBE3E5] bg-white p-4 shadow-soft"
      style={{ bottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}
    >
      <button
        type="button"
        onClick={close}
        aria-label="Close"
        className="bb-tap absolute right-2.5 top-2.5 p-1.5 text-[#59658d] hover:text-baby-ink"
      >
        <Icon name="close" className="h-5 w-5" strokeWidth={3.2} />
      </button>

      <div className="flex items-center gap-3 pr-9">
        {/* The transparent mascot (brain and face, uncropped) — the square app icon filled the frame edge to edge and read as cut off. */}
        <img src="/app/assets/brand/notify-icon.png" alt="" width={52} height={52} className="h-[52px] w-[52px] shrink-0 object-contain" />
        <h2 className="flex items-center gap-2 text-[17px] font-black leading-tight text-baby-ink">
          <span>Never miss an update</span>
          <Icon name="bell" className="h-5 w-5 shrink-0 text-baby-cta" />
        </h2>
      </div>
      <p className="mt-2 text-sm font-semibold leading-5 text-[#59658d]">
        Get a notification when a booking is confirmed or a class is coming up, even when BabyBrain is closed.
      </p>

      {error && <p className="mt-2 text-sm font-bold text-red-600">{error}</p>}

      <button
        type="button"
        onClick={turnOn}
        disabled={busy}
        className="mt-3.5 w-full rounded-[12px] bg-baby-cta py-3 text-[15px] font-black text-white shadow-pink transition hover:brightness-105 disabled:opacity-60"
      >
        {busy ? "Turning on…" : "Turn on notifications"}
      </button>
      <button type="button" onClick={notNow} className="mt-2 w-full py-1.5 text-center text-[13px] font-bold text-[#68718f] hover:text-baby-ink">
        Not now
      </button>
    </div>
  );
}
