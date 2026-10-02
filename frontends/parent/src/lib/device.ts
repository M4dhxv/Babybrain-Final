import { supabase } from "./supabase";
import { isStandalone } from "./install";

/**
 * Tells the server which device a signed-in parent is on and whether they're using the installed
 * app or the website, for the admin Parents page.
 *
 * The server can't work the second part out: a home-screen install sends the same user agent as the
 * browser, so only the page itself can see `display-mode: standalone`. Reported at most once every
 * few hours per device/mode (the server also ignores repeats within the hour), and strictly best
 * effort: a failure must never get in the parent's way.
 */
export type DeviceOs = "ios" | "android" | "macos" | "windows" | "chromeos" | "linux" | "other";

const KEY = "bb_device_reported";
const EVERY_MS = 6 * 60 * 60 * 1000;

export function detectOs(): DeviceOs {
  if (typeof navigator === "undefined") return "other";
  const ua = navigator.userAgent;
  // iPadOS reports itself as a Mac; the touch screen gives it away.
  if (/iPhone|iPad|iPod/.test(ua) || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1)) return "ios";
  if (/Android/i.test(ua)) return "android";
  if (/CrOS/.test(ua)) return "chromeos";
  if (/Windows/i.test(ua)) return "windows";
  if (/Macintosh|Mac OS/i.test(ua)) return "macos";
  if (/Linux/i.test(ua)) return "linux";
  return "other";
}

export function reportDevice(userId: string): void {
  try {
    const os = detectOs();
    const surface = isStandalone() ? "app" : "web";
    const sig = `${userId}|${os}|${surface}`;
    let last: { sig: string; at: number } | null = null;
    try { last = JSON.parse(localStorage.getItem(KEY) ?? "null"); } catch { /* storage blocked */ }
    if (last && last.sig === sig && Date.now() - last.at < EVERY_MS) return;
    // Not in the generated types (database.types.ts), hence the cast.
    void (supabase.rpc as unknown as (fn: string, args: Record<string, string>) => PromiseLike<{ error: unknown }>)(
      "record_parent_device", { p_os: os, p_surface: surface },
    ).then(({ error }) => {
      if (error) return;
      try { localStorage.setItem(KEY, JSON.stringify({ sig, at: Date.now() })); } catch { /* ignore */ }
    }, () => { /* offline: tried again next load */ });
  } catch { /* never break the app over analytics */ }
}
