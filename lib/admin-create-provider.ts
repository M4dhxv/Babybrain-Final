import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Create a directory vendor by hand, from /admin.
 *
 * Mirrors what `scripts/import-vendors.mjs` does for a crawled vendor and what
 * `scripts/add-vendor-by-hand.sql` did from the SQL editor, but as one call the
 * founder can make from the panel: the provider, its venues, and its classes.
 *
 * Two things are done for you because forgetting either has caused real bugs:
 *
 *  · **Coordinates.** A venue with no lat/lng gets no pin on Explore, which is
 *    what left multi-venue businesses showing a single pin for months. Every
 *    location (and the provider's own address) is geocoded through OneMap —
 *    postal code first since it's authoritative, then the address, then the
 *    venue name. `region` is derived from those by DB trigger, so the area
 *    filter starts working immediately too.
 *  · **is_auto_listed = false.** The weekly refresh only rewrites auto-listed
 *    vendors, so a hand-curated listing is never overwritten by the crawler.
 */

export const VENDOR_CATEGORIES = [
  'baby-toddler-classes',
  'playspaces',
  'camps-holiday',
  'community-events',
  'mum-bub-exercise',
  'other',
] as const;
export type VendorCategory = (typeof VENDOR_CATEGORIES)[number];

export type NewLocation = {
  name: string;
  address?: string | null;
  postal_code?: string | null;
};

export type NewActivity = {
  title: string;
  category_slug: string;
  description?: string | null;
  age_min_months?: number | null;
  age_max_months?: number | null;
  price?: number | null;
  is_published?: boolean;
};

export type NewProvider = {
  business_name: string;
  slug?: string | null;
  description?: string | null;
  vendor_category: VendorCategory;
  contact_email?: string | null;
  contact_phone?: string | null;
  whatsapp?: string | null;
  website?: string | null;
  address?: string | null;
  postal_code?: string | null;
  booking_url?: string | null;
  locations?: NewLocation[];
  activities?: NewActivity[];
};

export type CreateResult = {
  // `slug` is nullable on the table (a trigger fills it when absent), but we
  // always pass one, so it is never actually null here.
  provider: { id: string; slug: string | null; business_name: string; region: string | null };
  locations: number;
  activities: number;
  geocoded: number;
  warnings: string[];
};

export const slugify = (s: string) =>
  (s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 60);

/** BabyBrain lists activities for children up to 11. */
const MAX_AGE_MONTHS = 132;

type Coords = { lat: number; lng: number } | null;

/**
 * OneMap (data.gov.sg), no API key. Returns null rather than throwing — a
 * vendor that can't be placed is still worth creating, and the warning tells
 * the founder to add a postal code.
 */
async function oneMapSearch(term: string): Promise<Coords> {
  if (!term?.trim()) return null;
  const url =
    'https://www.onemap.gov.sg/api/common/elastic/search' +
    `?searchVal=${encodeURIComponent(term.trim())}&returnGeom=Y&getAddrDetails=Y&pageNum=1`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) }).then((r) => r.json());
    const hit = res?.results?.[0];
    if (!hit?.LATITUDE || !hit?.LONGITUDE) return null;
    const lat = Number(hit.LATITUDE);
    const lng = Number(hit.LONGITUDE);
    // Reject anything outside Singapore — OneMap will happily match a
    // same-named street elsewhere and drop a pin in the sea.
    if (!(lat > 1.15 && lat < 1.48 && lng > 103.5 && lng < 104.15)) return null;
    return { lat, lng };
  } catch {
    return null;
  }
}

/** Postal code is authoritative; fall back to the address, then the name. */
export async function geocode(parts: (string | null | undefined)[]): Promise<Coords> {
  for (const p of parts) {
    if (!p?.trim()) continue;
    const hit = await oneMapSearch(p);
    if (hit) return hit;
  }
  return null;
}

export async function createProviderWithCatalogue(input: NewProvider): Promise<CreateResult> {
  const db = createAdminClient();
  const warnings: string[] = [];

  const business_name = input.business_name?.trim();
  if (!business_name) throw new Error('Business name is required.');

  const slug = slugify(input.slug?.trim() || business_name);
  if (!slug) throw new Error('Could not build a slug from that business name.');

  // Fail before writing anything rather than surfacing a raw unique-violation.
  const { data: clash } = await db.from('providers').select('id').eq('slug', slug).maybeSingle();
  if (clash) throw new Error(`A vendor with the slug "${slug}" already exists.`);

  const cats = await db.from('activity_categories').select('id, slug');
  if (cats.error) throw new Error(`Could not read categories: ${cats.error.message}`);
  const catId = Object.fromEntries((cats.data ?? []).map((c) => [c.slug, c.id]));

  const activities = (input.activities ?? []).filter((a) => a.title?.trim());
  for (const a of activities) {
    if (!catId[a.category_slug]) throw new Error(`Unknown category "${a.category_slug}".`);
  }

  const providerCoords = await geocode([input.postal_code, input.address, business_name]);
  if (!providerCoords) {
    warnings.push('Could not place the main address — add a postal code so it appears on the map.');
  }

  const { data: created, error: pErr } = await db
    .from('providers')
    .insert({
      business_name,
      slug,
      // `undefined` rather than null on the optional text columns: the Insert
      // types treat an omitted field as "take the column default", which is
      // what an empty form field means here.
      description: input.description?.trim() || undefined,
      vendor_category: input.vendor_category,
      contact_email: input.contact_email?.trim() || null,
      contact_phone: input.contact_phone?.trim() || null,
      whatsapp: input.whatsapp?.trim() || null,
      website: input.website?.trim() || null,
      address: input.address?.trim() || null,
      postal_code: input.postal_code?.trim() || null,
      latitude: providerCoords?.lat ?? null,
      longitude: providerCoords?.lng ?? null,
      source_url: input.website?.trim() || null,
      is_claimed: false,
      is_auto_listed: false,
      verification_status: 'unverified',
      status: 'active',
      synced_at: new Date().toISOString(),
    })
    .select('id, slug, business_name, region')
    .single();

  if (pErr || !created) throw new Error(`Could not create the vendor: ${pErr?.message ?? 'unknown error'}`);

  /* From here on the provider row exists. Anything that fails below leaves a
     half-built vendor, which is worse than none — so undo and report. The
     FKs cascade, so removing the provider takes its children with it. */
  const undo = async (message: string): Promise<never> => {
    await db.from('providers').delete().eq('id', created.id);
    throw new Error(message);
  };

  let geocoded = providerCoords ? 1 : 0;

  const locations = (input.locations ?? []).filter((l) => l.name?.trim() || l.address?.trim());
  if (locations.length) {
    const rows = [];
    for (const [i, l] of locations.entries()) {
      const coords = await geocode([l.postal_code, l.address, l.name]);
      if (coords) geocoded += 1;
      else warnings.push(`Venue "${l.name || l.address}" could not be placed — no pin until it has a postal code.`);
      rows.push({
        provider_id: created.id,
        name: l.name?.trim() || business_name,
        address: l.address?.trim() || null,
        postal_code: l.postal_code?.trim() || null,
        latitude: coords?.lat ?? null,
        longitude: coords?.lng ?? null,
        is_primary: i === 0,
      });
    }
    const { error } = await db.from('provider_locations').insert(rows);
    if (error) await undo(`Vendor rolled back — its venues failed: ${error.message}`);
  } else if (input.address?.trim()) {
    // A vendor with an address but no explicit venue still needs one row, or it
    // contributes nothing to the map.
    const { error } = await db.from('provider_locations').insert({
      provider_id: created.id,
      name: business_name,
      address: input.address.trim(),
      postal_code: input.postal_code?.trim() || null,
      latitude: providerCoords?.lat ?? null,
      longitude: providerCoords?.lng ?? null,
      is_primary: true,
    });
    if (error) await undo(`Vendor rolled back — its venue failed: ${error.message}`);
  }

  if (activities.length) {
    const bookingUrl = input.booking_url?.trim() || input.website?.trim() || null;
    const rows = activities.map((a, i) => {
      const min = Math.max(0, Number.isFinite(a.age_min_months as number) ? (a.age_min_months as number) : 0);
      const max = Math.min(
        MAX_AGE_MONTHS,
        Number.isFinite(a.age_max_months as number) ? (a.age_max_months as number) : MAX_AGE_MONTHS
      );
      return {
        slug: `${slug}-${slugify(a.title) || 'class'}-${i}`.slice(0, 70),
        title: a.title.trim().slice(0, 120),
        description: a.description?.trim() || input.description?.trim() || undefined,
        category_id: catId[a.category_slug],
        provider_id: created.id,
        provider_name: business_name,
        vendor_category: input.vendor_category,
        // The check constraint requires min <= max; a form that says 24–12
        // should be a clear message, not a database error.
        age_min_months: Math.min(min, max),
        age_max_months: Math.max(min, max),
        price: a.price ?? null,
        address: input.address?.trim() || null,
        postal_code: input.postal_code?.trim() || null,
        image_urls: [],
        is_published: a.is_published ?? true,
        requires_medical_disclosure: false,
        external_booking_url: bookingUrl,
      };
    });
    const { error } = await db.from('activities').insert(rows);
    if (error) await undo(`Vendor rolled back — its classes failed: ${error.message}`);
  }

  // Re-read so the caller sees the region the trigger derived.
  const { data: fresh } = await db
    .from('providers')
    .select('id, slug, business_name, region')
    .eq('id', created.id)
    .single();

  return {
    provider: fresh ?? { ...created, region: null },
    locations: locations.length || (input.address?.trim() ? 1 : 0),
    activities: activities.length,
    geocoded,
    warnings,
  };
}
