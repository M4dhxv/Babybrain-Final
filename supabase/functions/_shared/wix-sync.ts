import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import {
  fetchWixServices,
  fetchWixResources,
  fetchWixLocations,
  wixServicePrice,
  wixServiceCapacity,
  wixServiceImageUrl,
  type WixCredentials,
  type WixService,
  type WixLocation,
} from './wix-client.ts';

/**
 * Deno port of syncWixServicesToActivities from lib/wix/sync.ts — the
 * refresh-only half the scheduled sync actually calls (no `onlyServiceIds`,
 * so it never creates a new activity, only keeps already-imported ones in
 * step — see the comment on the loop below, ported unchanged). The
 * create-new-listing path, unlinkWixActivities, and every booking-adjacent
 * function in the original file are deliberately not ported here — they're
 * only ever reached from an authenticated vendor session, which stays on
 * Vercel.
 *
 * Types use `SupabaseClient` with no generic — the Deno copy doesn't carry
 * types/database.ts's ~1400-line generated types, so table/column names
 * aren't compile-time checked here the way the Vercel original is. Correct
 * column names still matter at runtime; keep this in step with
 * lib/wix/sync.ts by eye (or diff) rather than relying on the type checker
 * to catch drift.
 */

export interface WixServiceSyncResult {
  created: number;
  updated: number;
  skipped: { name: string; reason: string }[];
  removed: number;
  revived: number;
}

async function resolveWixServiceLocation(
  admin: SupabaseClient,
  providerId: string,
  service: WixService,
  wixLocationsById: Map<string, WixLocation>,
  cache: Map<string, string | null>
): Promise<{ locationId: string | null; address: string | null; postalCode: string | null }> {
  const biz = service.locations?.find((l) => l.type === 'BUSINESS');
  if (!biz) return { locationId: null, address: null, postalCode: null };

  const known = wixLocationsById.get(biz.id);
  const address = known?.address ?? biz.calculatedAddress?.formattedAddress ?? null;
  const postalCode = known?.postalCode ?? biz.calculatedAddress?.postalCode ?? null;

  if (cache.has(biz.id)) return { locationId: cache.get(biz.id)!, address, postalCode };

  const { data: existing } = await admin
    .from('provider_locations')
    .select('id')
    .eq('provider_id', providerId)
    .eq('wix_location_id', biz.id)
    .maybeSingle();
  if (existing) {
    cache.set(biz.id, existing.id);
    return { locationId: existing.id, address, postalCode };
  }

  const { count } = await admin
    .from('provider_locations')
    .select('id', { count: 'exact', head: true })
    .eq('provider_id', providerId);

  const { data: created } = await admin
    .from('provider_locations')
    .insert({
      provider_id: providerId,
      name: known?.name ?? 'Wix location',
      address,
      postal_code: postalCode,
      wix_location_id: biz.id,
      is_primary: (count ?? 0) === 0,
    })
    .select('id')
    .single();
  cache.set(biz.id, created?.id ?? null);
  return { locationId: created?.id ?? null, address, postalCode };
}

/** Not needed on the refresh-only path (nothing new is created here), kept
 *  only because syncWixServicesToActivities's create branch is ported for
 *  fidelity even though onlyServiceIds is never passed by the scheduled
 *  caller — dead code on this path today, cheap to keep in step. */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'wix-service';
}

const VENDOR_OVERRIDABLE_WIX_FIELDS = new Set(['price', 'title', 'description', 'image_urls']);

export async function syncWixServicesToActivities(
  admin: SupabaseClient,
  providerId: string,
  creds: WixCredentials,
  options?: { onlyServiceIds?: string[] }
): Promise<WixServiceSyncResult> {
  const [services, resources, wixLocations] = await Promise.all([
    fetchWixServices(creds),
    fetchWixResources(creds),
    fetchWixLocations(creds).catch(() => [] as WixLocation[]),
  ]);
  const bookableResources = resources.filter((r) => r.bookable);
  const resourceForService = (service: WixService) =>
    bookableResources.find((r) => service.staffMemberIds?.includes(r.id)) ?? bookableResources[0];
  const wixLocationsById = new Map(wixLocations.map((l) => [l.id, l]));
  const locationCache = new Map<string, string | null>();

  const { data: category } = await admin
    .from('activity_categories')
    .select('id')
    .order('sort_order')
    .limit(1)
    .single();

  const result: WixServiceSyncResult = { created: 0, updated: 0, skipped: [], removed: 0, revived: 0 };

  // The scheduled caller always passes nothing here — see the module doc.
  const explicitIds = options?.onlyServiceIds ? new Set(options.onlyServiceIds) : null;

  const { data: linkedRows } = await admin
    .from('activities')
    .select('id, wix_service_id, wix_missing_since, wix_locked_fields')
    .eq('provider_id', providerId)
    .not('wix_service_id', 'is', null);
  const linkedByServiceId = new Map(
    (linkedRows ?? []).map((r: any) => [r.wix_service_id as string, r])
  );

  for (const service of services) {
    const existing = linkedByServiceId.get(service.id) ?? null;
    const mayCreate = !!explicitIds && explicitIds.has(service.id);
    if (!existing && !mayCreate) continue;

    const type =
      service.type === 'APPOINTMENT' || service.type === 'CLASS' || service.type === 'COURSE'
        ? service.type
        : null;
    if (!type) {
      result.skipped.push({ name: service.name, reason: `Unsupported Wix service type "${service.type}"` });
      continue;
    }
    const resource = resourceForService(service);
    if (type === 'APPOINTMENT' && !resource) {
      result.skipped.push({ name: service.name, reason: 'No bookable staff/resource found on the Wix account' });
      continue;
    }

    const { locationId, address, postalCode } = await resolveWixServiceLocation(
      admin, providerId, service, wixLocationsById, locationCache
    );
    const price = wixServicePrice(service);
    const capacity = wixServiceCapacity(service);
    const imageUrl = wixServiceImageUrl(service);
    const wixDescription = service.description?.trim() || null;

    if (existing) {
      const patch: Record<string, unknown> = {
        title: service.name,
        wix_service_type: type,
        wix_resource_id: type === 'APPOINTMENT' ? resource!.id : null,
        location_id: locationId,
        address,
        postal_code: postalCode,
        ...(price != null ? { price } : {}),
        ...(capacity != null ? { default_capacity: capacity } : {}),
        ...(imageUrl ? { image_urls: [imageUrl] } : {}),
        ...(wixDescription ? { description: wixDescription } : {}),
        wix_missing_since: null,
      };
      for (const field of existing.wix_locked_fields ?? []) {
        if (VENDOR_OVERRIDABLE_WIX_FIELDS.has(field)) {
          delete patch[field];
        }
      }
      patch.wix_price = price;
      await admin
        .from('activities')
        .update(patch)
        .eq('id', existing.id);
      if (existing.wix_missing_since) result.revived++;
      result.updated++;
      continue;
    }

    if (!category) {
      result.skipped.push({ name: service.name, reason: 'No activity category exists to assign yet' });
      continue;
    }

    const slug = `${slugify(service.name)}-${service.id.slice(0, 6)}`;
    const description =
      wixDescription ||
      'Imported from Wix. Finish this listing — category, age range and description — then publish it when ready.';
    const { error } = await admin.from('activities').insert({
      slug,
      title: service.name,
      description,
      category_id: category.id,
      provider_id: providerId,
      is_published: false,
      wix_service_id: service.id,
      wix_service_type: type,
      wix_resource_id: type === 'APPOINTMENT' ? resource!.id : null,
      location_id: locationId,
      address,
      postal_code: postalCode,
      price,
      wix_price: price,
      default_capacity: capacity,
      image_urls: imageUrl ? [imageUrl] : [],
    });
    if (error) {
      result.skipped.push({ name: service.name, reason: error.message });
      continue;
    }
    result.created++;
  }

  const fetchedServiceIds = new Set(services.map((s) => s.id));
  const { data: linked } = await admin
    .from('activities')
    .select('id, wix_service_id')
    .eq('provider_id', providerId)
    .not('wix_service_id', 'is', null)
    .is('wix_missing_since', null);
  for (const act of linked ?? []) {
    if (act.wix_service_id && !fetchedServiceIds.has(act.wix_service_id)) {
      await admin
        .from('activities')
        .update({ wix_missing_since: new Date().toISOString(), is_published: false })
        .eq('id', act.id);
      result.removed++;
    }
  }

  return result;
}
