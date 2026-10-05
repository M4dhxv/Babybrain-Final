/** Deno copy of the address lookup in lib/geocode.ts (keep the two in step). */
export interface AddressGeocode {
  postalCode: string;
  latitude: number;
  longitude: number;
}

interface OneMapHit {
  BLK_NO?: string;
  ROAD_NAME?: string;
  POSTAL?: string;
  LATITUDE: string;
  LONGITUDE: string;
}

/** Which OneMap result, if any, is safely THE place a street address names. A wrong place is worse than none
 *  (it puts a class on someone else's map pin), so a hit is only taken when OneMap found exactly one, or when
 *  the first one has the address's own block number and the address's road name inside its road. */
export function pickAddressHit(address: string, found: number, results: OneMapHit[]): AddressGeocode | null {
  const hit = results[0];
  if (!hit || !/^\d{6}$/.test(hit.POSTAL ?? '')) return null;
  let ok = found === 1 && results.length === 1;
  if (!ok) {
    const m = address.trim().match(/^(\d+[A-Za-z]?)\s+(.+)$/);
    if (m && (hit.BLK_NO ?? '').toUpperCase() === m[1].toUpperCase()) {
      // "Prince Charles Cres" -> prince, charles (the last word is usually an abbreviation of the road type).
      const words = m[2].toLowerCase().split(/[^a-z]+/).filter(Boolean);
      const road = (hit.ROAD_NAME ?? '').toLowerCase();
      const need = words.slice(0, Math.max(1, words.length - 1));
      ok = need.length > 0 && need.every((w) => road.includes(w));
    }
  }
  const latitude = parseFloat(hit.LATITUDE);
  const longitude = parseFloat(hit.LONGITUDE);
  if (!ok || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return { postalCode: hit.POSTAL as string, latitude, longitude };
}

/** A Singapore street address ("103 Prince Charles Cres, Singapore") -> postal code and coordinates via OneMap,
 *  for a venue Wix sent without a postal code. Null when OneMap is unreachable or the match isn't certain. */
export async function geocodeAddress(address: string): Promise<AddressGeocode | null> {
  const query = address.replace(/,?\s*singapore(\s+\d{6})?\s*$/i, '').trim();
  if (!query) return null;
  const url =
    'https://www.onemap.gov.sg/api/common/elastic/search' +
    `?searchVal=${encodeURIComponent(query)}&returnGeom=Y&getAddrDetails=Y&pageNum=1`;
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { found?: number; results?: OneMapHit[] };
    return pickAddressHit(query, data.found ?? 0, data.results ?? []);
  } catch {
    return null;
  }
}
