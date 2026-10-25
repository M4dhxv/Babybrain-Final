/**
 * Admin view: a Babybrain admin working inside a vendor's portal as a manager
 * (admin → Vendors → "Open vendor portal"; migration 00251).
 *
 * The admin portal opens `/vendor/?as=<providerId>&admin_token=<hash>`. The
 * token signs the admin's own account in here (one-time, read once below);
 * `as` says which vendor to show and is remembered in localStorage until the
 * admin leaves the view, so a refresh stays on that vendor.
 */

const KEY = 'bb:vendor-admin-view';

let pendingToken: string | null = null;
/** Fallback for when localStorage is blocked. */
let memoryTarget: string | null = null;

if (typeof window !== 'undefined') {
  const q = new URLSearchParams(window.location.search);
  const as = q.get('as');
  const token = q.get('admin_token');
  if (as || token) {
    if (as) {
      try { localStorage.setItem(KEY, as); } catch { /* storage blocked: this tab only */ }
      memoryTarget = as;
    }
    pendingToken = token;
    q.delete('as');
    q.delete('admin_token');
    const rest = q.toString();
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${rest ? `?${rest}` : ''}${window.location.hash}`
    );
  }
}

/** The vendor an admin is viewing, or null when this is a normal vendor sign-in. */
export function getAdminTarget(): string | null {
  try {
    return localStorage.getItem(KEY) ?? memoryTarget ?? null;
  } catch {
    return memoryTarget ?? null;
  }
}

export function clearAdminTarget(): void {
  memoryTarget = null;
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}

/** The one-time sign-in token from the admin portal's link, if this load came from one. */
export function takeAdminToken(): string | null {
  const t = pendingToken;
  pendingToken = null;
  return t;
}
