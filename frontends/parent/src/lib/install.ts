import { useSyncExternalStore } from "react";

/**
 * "Install the app" plumbing for the parent site.
 *
 * Chromium browsers (Android Chrome, Samsung Internet, desktop Chrome/Edge) announce that the
 * site can be installed with a `beforeinstallprompt` event. It fires once, early, so it is caught
 * here at module load and held until the banner (or the menu link) is ready to use it. Safari on
 * iPhone/iPad has no such event or API, so there the banner shows the manual "Share → Add to Home
 * Screen" steps instead.
 */

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export const SNOOZE_KEY = "bb_install_snooze_until";
export const DONE_KEY = "bb_install_done";
export const VISITS_KEY = "bb_visits";
export const ACTIVITY_VIEWS_KEY = "bb_activity_views";

export const NOT_NOW_MS = 5 * 24 * 60 * 60 * 1000; // "Not now": 5 days
export const CLOSE_MS = 24 * 60 * 60 * 1000; // the cross: 24 hours

const read = (k: string): string | null => {
  try { return localStorage.getItem(k); } catch { return null; }
};
const write = (k: string, v: string) => {
  try { localStorage.setItem(k, v); } catch { /* private mode — the banner just may come back sooner */ }
};

export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/** Safari on iPhone / iPad (including iPadOS, which reports itself as a Mac). */
export function isIosSafari(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  const ios = /iPad|iPhone|iPod/.test(ua) || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1);
  const otherBrowser = /CriOS|FxiOS|EdgiOS|OPiOS|GSA\//.test(ua);
  return ios && !otherBrowser;
}

let deferred: InstallPromptEvent | null = null;
let installed = isStandalone() || read(DONE_KEY) === "1";
let forced = false; // opened on purpose from the menu link, ignoring the snooze
const listeners = new Set<() => void>();

export interface InstallState {
  /** The browser can show its own install dialog. */
  native: boolean;
  /** iPhone / iPad Safari: manual steps only. */
  ios: boolean;
  installed: boolean;
  forced: boolean;
}
let snapshot: InstallState = compute();

function compute(): InstallState {
  return { native: deferred !== null, ios: isIosSafari(), installed, forced };
}
function emit() {
  snapshot = compute();
  listeners.forEach((l) => l());
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // hold it: we choose when to show the prompt
    deferred = e as InstallPromptEvent;
    emit();
  });
  window.addEventListener("appinstalled", () => {
    installed = true;
    deferred = null;
    write(DONE_KEY, "1");
    emit();
  });
}

export function useInstallState(): InstallState {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    () => snapshot,
    () => snapshot
  );
}

/** Opens the browser's own install dialog. Resolves true if the parent accepted. */
export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false;
  const event = deferred;
  deferred = null; // an event can only be used once
  emit();
  try {
    await event.prompt();
    const { outcome } = await event.userChoice;
    if (outcome === "accepted") {
      installed = true;
      write(DONE_KEY, "1");
      emit();
      return true;
    }
  } catch { /* the dialog could not open; treat like a decline */ }
  return false;
}

export function snoozeInstall(ms: number) {
  write(SNOOZE_KEY, String(Date.now() + ms));
  forced = false;
  emit();
}

export const isSnoozed = (): boolean => Number(read(SNOOZE_KEY) ?? 0) > Date.now();

/** "Install app" in the menu: the native dialog where there is one, otherwise the steps banner. */
export async function requestInstall() {
  if (deferred) {
    await promptInstall();
    return;
  }
  forced = true;
  emit();
}

/** Counts this browser session as one visit (once), for the "second visit" rule. */
export function countVisit() {
  try {
    if (sessionStorage.getItem("bb_visit_counted")) return;
    sessionStorage.setItem("bb_visit_counted", "1");
  } catch { /* fall through and count it */ }
  write(VISITS_KEY, String(Number(read(VISITS_KEY) ?? 0) + 1));
}
export const countActivityView = () => write(ACTIVITY_VIEWS_KEY, String(Number(read(ACTIVITY_VIEWS_KEY) ?? 0) + 1));
export const hasEngaged = (): boolean =>
  Number(read(VISITS_KEY) ?? 0) >= 2 || Number(read(ACTIVITY_VIEWS_KEY) ?? 0) >= 1;
