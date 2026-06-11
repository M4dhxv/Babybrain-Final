/** Singapore postal code → coordinates via OneMap (free, no API key). */
export async function geocodePostalCode(postalCode: string): Promise<{
  latitude: number;
  longitude: number;
  address: string | null;
} | null> {
  const url =
    'https://www.onemap.gov.sg/api/common/elastic/search' +
    `?searchVal=${encodeURIComponent(postalCode)}&returnGeom=Y&getAddrDetails=Y&pageNum=1`;

  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      results?: { LATITUDE: string; LONGITUDE: string; ADDRESS?: string }[];
    };
    const hit = data.results?.[0];
    if (!hit) return null;
    return {
      latitude: parseFloat(hit.LATITUDE),
      longitude: parseFloat(hit.LONGITUDE),
      address: hit.ADDRESS ?? null,
    };
  } catch {
    return null;
  }
}
