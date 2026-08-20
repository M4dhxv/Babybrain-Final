import { createAdminClient } from '@/lib/supabase/admin';
import { geocode, slugify, sgToUtcIso, VENDOR_CATEGORIES, type VendorCategory } from '@/lib/admin-create-provider';

/**
 * Read and edit an existing directory vendor from /admin — the business, its
 * venues and its classes.
 *
 * Companion to {@link createProviderWithCatalogue}. Editing is patch-style:
 * only fields actually present in the request are written, so the form can send
 * one section without blanking the rest.
 *
 * Address changes re-run the OneMap lookup, because `region` and the map pin
 * derive from the coordinates — leaving stale ones behind is how a vendor ends
 * up filed under the wrong area after a move.
 */

export type ProviderDetail = {
  id: string;
  business_name: string;
  slug: string | null;
  description: string | null;
  vendor_category: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  whatsapp: string | null;
  website: string | null;
  address: string | null;
  postal_code: string | null;
  region: string | null;
  status: string;
  is_claimed: boolean;
  is_auto_listed: boolean;
  latitude: number | null;
  longitude: number | null;
  logo_url: string | null;
  cover_image_url: string | null;
  uen: string | null;
  social: { instagram?: string | null; facebook?: string | null; tiktok?: string | null } | null;
  locations: {
    id: string; name: string; address: string | null; postal_code: string | null;
    region: string | null; is_primary: boolean; latitude: number | null; longitude: number | null;
  }[];
  activities: {
    id: string; title: string; slug: string; category_slug: string | null; category_name: string | null;
    age_min_months: number; age_max_months: number; price: number | null; is_published: boolean;
    description: string | null; external_booking_url: string | null;
    image_urls: string[]; requires_medical_disclosure: boolean; bookings_paused: boolean;
    /** Upcoming sessions, as Singapore wall-clock for the form. */
    sessions: { id: string; starts_at: string; ends_at: string; capacity: number | null;
                teacher_name: string | null; studio: string | null }[];
  }[];
};

/** UTC ISO -> "YYYY-MM-DDTHH:mm" in Singapore, for <input type="datetime-local">. */
function utcToSgLocal(iso: string): string {
  const d = new Date(iso);
  const sg = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  return sg.toISOString().slice(0, 16);
}

export async function getProviderDetail(id: string): Promise<ProviderDetail | null> {
  const db = createAdminClient();

  const { data: p, error } = await db
    .from('providers')
    .select(
      'id, business_name, slug, description, vendor_category, contact_email, contact_phone, whatsapp, ' +
        'website, address, postal_code, region, status, is_claimed, is_auto_listed, latitude, longitude, ' +
        'logo_url, cover_image_url, uen, social'
    )
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!p) return null;

  const [locs, acts, cats] = await Promise.all([
    db.from('provider_locations')
      .select('id, name, address, postal_code, region, is_primary, latitude, longitude')
      .eq('provider_id', id).order('is_primary', { ascending: false }).order('name'),
    db.from('activities')
      .select('id, title, slug, category_id, age_min_months, age_max_months, price, is_published, ' +
              'description, external_booking_url, image_urls, requires_medical_disclosure, bookings_paused')
      .eq('provider_id', id).order('title'),
    db.from('activity_categories').select('id, slug, name'),
  ]);

  const catById = Object.fromEntries((cats.data ?? []).map((c) => [c.id, c]));
  /* The select lists are built by concatenation for readability, which defeats
     supabase-js's literal-type inference — so the rows come back untyped and
     are asserted here instead. */
  type RawActivity = {
    id: string; title: string; slug: string; category_id: number;
    age_min_months: number; age_max_months: number; price: number | null;
    is_published: boolean; description: string | null; external_booking_url: string | null;
    image_urls: string[] | null; requires_medical_disclosure: boolean; bookings_paused: boolean;
  };
  const actRows = (acts.data ?? []) as unknown as RawActivity[];
  const actIds = actRows.map((a) => a.id);

  // Sessions for every class in one round trip, newest-relevant first.
  const sessions = actIds.length
    ? (await db.from('activity_sessions')
        .select('id, activity_id, starts_at, ends_at, capacity, teacher_name, studio')
        .in('activity_id', actIds)
        .order('starts_at')).data ?? []
    : [];
  const sessByAct = new Map<string, ProviderDetail['activities'][number]['sessions']>();
  for (const s of sessions as unknown as Array<{ id: string; activity_id: string; starts_at: string;
      ends_at: string; capacity: number | null; teacher_name: string | null; studio: string | null }>) {
    const list = sessByAct.get(s.activity_id) ?? [];
    list.push({
      id: s.id,
      starts_at: utcToSgLocal(s.starts_at),
      ends_at: utcToSgLocal(s.ends_at),
      capacity: s.capacity,
      teacher_name: s.teacher_name,
      studio: s.studio,
    });
    sessByAct.set(s.activity_id, list);
  }

  return {
    ...(p as unknown as Omit<ProviderDetail, 'locations' | 'activities'>),
    locations: (locs.data ?? []) as unknown as ProviderDetail['locations'],
    activities: actRows.map((a) => {
      const c = catById[a.category_id];
      return {
        id: a.id, title: a.title, slug: a.slug,
        category_slug: c?.slug ?? null, category_name: c?.name ?? null,
        age_min_months: a.age_min_months, age_max_months: a.age_max_months,
        price: a.price, is_published: a.is_published, description: a.description,
        external_booking_url: a.external_booking_url,
        image_urls: a.image_urls ?? [],
        requires_medical_disclosure: a.requires_medical_disclosure,
        bookings_paused: a.bookings_paused,
        sessions: sessByAct.get(a.id) ?? [],
      };
    }),
  };
}

export type ProviderPatch = Partial<{
  business_name: string;
  slug: string;
  description: string | null;
  vendor_category: VendorCategory;
  contact_email: string | null;
  contact_phone: string | null;
  whatsapp: string | null;
  website: string | null;
  address: string | null;
  postal_code: string | null;
  status: 'draft' | 'pending' | 'active' | 'suspended';
  logo_url: string | null;
  cover_image_url: string | null;
  uen: string | null;
  social: { instagram?: string | null; facebook?: string | null; tiktok?: string | null };
}>;

export type SessionPatch = {
  id?: string;                 // absent = create
  starts_at?: string;          // SG wall-clock from the form
  duration_mins?: number | null;
  capacity?: number | null;
  teacher_name?: string | null;
  studio?: string | null;
  _delete?: boolean;
};

export type LocationPatch = {
  id?: string;               // absent = create
  name?: string;
  address?: string | null;
  postal_code?: string | null;
  is_primary?: boolean;
  _delete?: boolean;
};

export type ActivityPatch = {
  id: string;                // activities are only edited here, never created
  title?: string;
  category_slug?: string;
  description?: string | null;
  age_min_months?: number;
  age_max_months?: number;
  price?: number | null;
  is_published?: boolean;
  image_urls?: string[];
  external_booking_url?: string | null;
  requires_medical_disclosure?: boolean;
  bookings_paused?: boolean;
  sessions?: SessionPatch[];
  _delete?: boolean;
};

export type UpdateResult = {
  provider: { id: string; business_name: string; slug: string | null; region: string | null };
  locationsChanged: number;
  activitiesChanged: number;
  sessionsChanged: number;
  regeocoded: boolean;
  warnings: string[];
};

const MAX_AGE_MONTHS = 132;

export async function updateProviderWithCatalogue(
  id: string,
  input: { provider?: ProviderPatch; locations?: LocationPatch[]; activities?: ActivityPatch[] }
): Promise<UpdateResult> {
  const db = createAdminClient();
  const warnings: string[] = [];

  const { data: before } = await db
    .from('providers').select('id, address, postal_code, business_name').eq('id', id).maybeSingle();
  if (!before) throw new Error('That vendor no longer exists.');

  let regeocoded = false;

  // ---- the business ----
  const patch = input.provider ?? {};
  if (Object.keys(patch).length) {
    const row: Record<string, unknown> = {};
    for (const k of ['business_name', 'description', 'contact_email', 'contact_phone',
                     'whatsapp', 'website', 'address', 'postal_code', 'status',
                     'logo_url', 'cover_image_url', 'uen'] as const) {
      if (k in patch) row[k] = (patch[k] as string | null) ?? null;
    }
    if (patch.social) {
      row.social = {
        instagram: patch.social.instagram?.trim() || null,
        facebook: patch.social.facebook?.trim() || null,
        tiktok: patch.social.tiktok?.trim() || null,
      };
    }
    if (patch.vendor_category) {
      if (!VENDOR_CATEGORIES.includes(patch.vendor_category)) throw new Error('Unknown business type.');
      row.vendor_category = patch.vendor_category;
    }
    if (patch.slug !== undefined) {
      const s = slugify(patch.slug);
      if (!s) throw new Error('That page address is empty once tidied up.');
      const { data: clash } = await db.from('providers').select('id').eq('slug', s).neq('id', id).maybeSingle();
      if (clash) throw new Error(`Another vendor already uses the slug "${s}".`);
      row.slug = s;
      warnings.push(`Page address is now "${s}" — any link using the old one will 404.`);
    }

    // Re-place on the map when the address moved. region follows by trigger.
    const addrChanged =
      ('address' in patch && (patch.address ?? null) !== before.address) ||
      ('postal_code' in patch && (patch.postal_code ?? null) !== before.postal_code);
    if (addrChanged) {
      const coords = await geocode([
        patch.postal_code ?? before.postal_code,
        patch.address ?? before.address,
        patch.business_name ?? before.business_name,
      ]);
      if (coords) {
        row.latitude = coords.lat;
        row.longitude = coords.lng;
        regeocoded = true;
      } else {
        warnings.push('New address could not be placed — the old map pin was kept.');
      }
    }

    row.updated_at = new Date().toISOString();
    const { error } = await db.from('providers').update(row as never).eq('id', id);
    if (error) throw new Error(`Could not save the business: ${error.message}`);

    /* Activities keep their own copy of the address, and Explore's area filter
       reads `activities.region` — which is derived from that copy. Without this
       a vendor that moves keeps its classes filed under the old area, so the
       business shows as East while its classes still answer to Central. */
    if (addrChanged) {
      const { error: aErr } = await db
        .from('activities')
        .update({
          address: (patch.address ?? before.address) || null,
          postal_code: (patch.postal_code ?? before.postal_code) || null,
        } as never)
        .eq('provider_id', id);
      if (aErr) warnings.push(`Classes kept the old address — ${aErr.message}`);
    }
  }

  // ---- venues ----
  let locationsChanged = 0;
  for (const l of input.locations ?? []) {
    if (l._delete && l.id) {
      const { error } = await db.from('provider_locations').delete().eq('id', l.id).eq('provider_id', id);
      if (error) throw new Error(`Could not remove a venue: ${error.message}`);
      locationsChanged += 1;
      continue;
    }
    // Geocode whenever we have something to go on; a venue without coordinates
    // contributes no pin, which is the bug this whole flow exists to avoid.
    const coords = await geocode([l.postal_code, l.address, l.name]);
    if (!coords && (l.postal_code || l.address)) {
      warnings.push(`Venue "${l.name || l.address}" could not be placed — no pin until its postal code is right.`);
    }
    const row: Record<string, unknown> = {};
    if (l.name !== undefined) row.name = l.name;
    if (l.address !== undefined) row.address = l.address || null;
    if (l.postal_code !== undefined) row.postal_code = l.postal_code || null;
    if (l.is_primary !== undefined) row.is_primary = l.is_primary;
    if (coords) { row.latitude = coords.lat; row.longitude = coords.lng; }

    if (l.id) {
      const { error } = await db.from('provider_locations').update(row as never).eq('id', l.id).eq('provider_id', id);
      if (error) throw new Error(`Could not save a venue: ${error.message}`);
    } else {
      const { error } = await db.from('provider_locations')
        .insert({ ...row, provider_id: id, name: l.name || before.business_name } as never);
      if (error) throw new Error(`Could not add a venue: ${error.message}`);
    }
    locationsChanged += 1;
  }

  // ---- classes ----
  let activitiesChanged = 0;
  let sessionsChanged = 0;
  const acts = input.activities ?? [];
  if (acts.length) {
    const { data: cats } = await db.from('activity_categories').select('id, slug');
    const catId = Object.fromEntries((cats ?? []).map((c) => [c.slug, c.id]));

    for (const a of acts) {
      if (a._delete) {
        const { error } = await db.from('activities').delete().eq('id', a.id).eq('provider_id', id);
        if (error) throw new Error(`Could not remove a class: ${error.message}`);
        activitiesChanged += 1;
        continue;
      }
      const row: Record<string, unknown> = {};
      if (a.title !== undefined) row.title = a.title.slice(0, 120);
      if (a.description !== undefined) row.description = a.description || null;
      if (a.price !== undefined) row.price = a.price;
      if (a.is_published !== undefined) row.is_published = a.is_published;
      if (a.image_urls !== undefined) row.image_urls = a.image_urls.map((u) => u.trim()).filter(Boolean);
      if (a.external_booking_url !== undefined) row.external_booking_url = a.external_booking_url || null;
      if (a.requires_medical_disclosure !== undefined) row.requires_medical_disclosure = a.requires_medical_disclosure;
      if (a.bookings_paused !== undefined) row.bookings_paused = a.bookings_paused;
      if (a.category_slug !== undefined) {
        if (!catId[a.category_slug]) throw new Error(`Unknown category "${a.category_slug}".`);
        row.category_id = catId[a.category_slug];
      }
      // The age_range_valid check constraint would otherwise surface as a raw
      // Postgres error; clamp and order it so the message stays human.
      if (a.age_min_months !== undefined || a.age_max_months !== undefined) {
        const min = Math.max(0, a.age_min_months ?? 0);
        const max = Math.min(MAX_AGE_MONTHS, a.age_max_months ?? MAX_AGE_MONTHS);
        row.age_min_months = Math.min(min, max);
        row.age_max_months = Math.max(min, max);
      }
      if (Object.keys(row).length) {
        const { error } = await db.from('activities').update(row as never).eq('id', a.id).eq('provider_id', id);
        if (error) throw new Error(`Could not save a class: ${error.message}`);
        activitiesChanged += 1;
      }

      /* Sessions. A class with none shows "Schedule TBC" and can't be booked,
         which is the state most of the catalogue is in — so this is the point
         of the whole editor for a lot of listings. */
      for (const s of a.sessions ?? []) {
        if (s._delete && s.id) {
          const { error } = await db.from('activity_sessions').delete().eq('id', s.id).eq('activity_id', a.id);
          if (error) throw new Error(`Could not remove a session: ${error.message}`);
          sessionsChanged += 1;
          continue;
        }
        const sRow: Record<string, unknown> = {};
        if (s.starts_at !== undefined) {
          const startsIso = sgToUtcIso(s.starts_at);
          sRow.starts_at = startsIso;
          const mins = Number.isFinite(s.duration_mins as number) && (s.duration_mins as number) > 0
            ? (s.duration_mins as number) : 60;
          sRow.ends_at = new Date(new Date(startsIso).getTime() + mins * 60_000).toISOString();
        }
        if (s.capacity !== undefined) sRow.capacity = s.capacity;
        if (s.teacher_name !== undefined) sRow.teacher_name = s.teacher_name || null;
        if (s.studio !== undefined) sRow.studio = s.studio || null;
        if (!Object.keys(sRow).length) continue;

        if (s.id) {
          const { error } = await db.from('activity_sessions').update(sRow as never).eq('id', s.id).eq('activity_id', a.id);
          if (error) throw new Error(`Could not save a session: ${error.message}`);
        } else {
          if (!sRow.starts_at) continue;   // a blank new row is just an unused slot
          const { error } = await db.from('activity_sessions')
            .insert({ ...sRow, activity_id: a.id } as never);
          if (error) throw new Error(`Could not add a session: ${error.message}`);
        }
        sessionsChanged += 1;
      }
    }
  }

  const { data: fresh } = await db
    .from('providers').select('id, business_name, slug, region').eq('id', id).single();

  return {
    provider: fresh as UpdateResult['provider'],
    locationsChanged,
    activitiesChanged,
    sessionsChanged,
    regeocoded,
    warnings,
  };
}
