import { apiPost } from '@/lib/api';

/**
 * Resolve a Singapore postal code to coordinates via the authenticated
 * /api/geocode (OneMap) — the same route the onboarding and /admin flows use.
 *
 * Best-effort by design: a non-6-digit code or a failed lookup returns null,
 * and the caller saves without coordinates rather than blocking on it.
 * Geocoding must never be the reason a vendor can't save their own details.
 *
 * Shared between the venue editor and the business-profile editor — both write
 * an address whose coordinates drive the Explore map pin and the area filter,
 * and a copy that only one of them ran was how a saved address ended up with a
 * stale pin.
 */
export async function geocodePostal(
  postalCode: string
): Promise<{ latitude: number; longitude: number } | null> {
  const code = postalCode.trim();
  if (!/^\d{6}$/.test(code)) return null;
  try {
    const r = await apiPost<{ latitude: number; longitude: number }>('/api/geocode', {
      postal_code: code,
    });
    return Number.isFinite(r.latitude) && Number.isFinite(r.longitude)
      ? { latitude: r.latitude, longitude: r.longitude }
      : null;
  } catch {
    return null;
  }
}
