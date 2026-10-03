/** Native share sheet and maps links: the phone-native routes for passing a
 *  booking on (WhatsApp, iMessage, AirDrop, Save to Files) and for getting
 *  directions. Everything here degrades to "not offered" where the browser
 *  has no share sheet (most desktops), so no button appears that can't work. */

import { isAppleDevice } from "./ics";

/** The browser has a share sheet at all (iOS Safari, Android Chrome, installed app). */
export function canShare(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.share === "function";
}

/** The share sheet can also take this file (iOS 15+, Android Chrome). */
export function canShareFile(file: File): boolean {
  try {
    return canShare() && typeof navigator.canShare === "function" && navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

/** Opens the share sheet. Resolves false when it could not open; a parent
 *  closing the sheet without choosing anything is not an error. */
export async function share(data: ShareData): Promise<boolean> {
  if (!canShare()) return false;
  try {
    await navigator.share(data);
    return true;
  } catch (e) {
    return e instanceof DOMException && e.name === "AbortError";
  }
}

/** Directions to a venue: Apple Maps on iPhone / iPad / Mac (it opens the
 *  Maps app), Google Maps everywhere else. */
export function mapsUrl(address: string): string {
  const q = encodeURIComponent(address);
  return isAppleDevice()
    ? `https://maps.apple.com/?q=${q}`
    : `https://www.google.com/maps/search/?api=1&query=${q}`;
}
