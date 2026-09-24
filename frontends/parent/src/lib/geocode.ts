import { apiPost } from "./api";

/**
 * Resolve a Singapore postal code to coordinates via the authenticated
 * /api/geocode (OneMap) — same route the vendor portal's venue/business
 * editors use (frontends/vendor/src/lib/geocode.ts).
 *
 * Best-effort by design: a non-6-digit code or a failed lookup returns null,
 * and the caller saves the profile without coordinates rather than blocking
 * on it. Geocoding must never be the reason a parent can't finish onboarding
 * or save their profile.
 */
export async function geocodePostal(
  postalCode: string
): Promise<{ latitude: number; longitude: number } | null> {
  const code = postalCode.trim();
  if (!/^\d{6}$/.test(code)) return null;
  try {
    const r = await apiPost<{ latitude: number; longitude: number }>("/api/geocode", {
      postal_code: code,
    });
    return Number.isFinite(r.latitude) && Number.isFinite(r.longitude)
      ? { latitude: r.latitude, longitude: r.longitude }
      : null;
  } catch {
    return null;
  }
}
