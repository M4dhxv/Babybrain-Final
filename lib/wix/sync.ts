import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { fetchWixServices, fetchWixResources, type WixCredentials } from './client';

/**
 * Turns every service on a vendor's connected Wix account (appointment or
 * class/course) into a local activities row, so nothing on their Wix
 * account has to be re-entered by hand to show up on BabyBrain.
 *
 * Safe to call repeatedly — matched on (provider_id, wix_service_id), so a
 * re-sync after new Wix services are added only creates the new ones.
 * Existing rows only get their name/resource kept in step; whatever the
 * vendor has since edited (category, age range, price, description,
 * publish state) is left alone rather than being silently overwritten.
 *
 * New rows land unpublished (activities.is_published defaults to false) —
 * imported straight from Wix, a listing has no category, age range or
 * price a parent could search by, so it needs a vendor's review before it
 * goes live on the marketplace.
 */

export interface WixServiceSyncResult {
  created: number;
  updated: number;
  skipped: { name: string; reason: string }[];
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'wix-service';
}

export async function syncWixServicesToActivities(
  admin: SupabaseClient<Database>,
  providerId: string,
  creds: WixCredentials
): Promise<WixServiceSyncResult> {
  const [services, resources] = await Promise.all([
    fetchWixServices(creds),
    fetchWixResources(creds),
  ]);
  // Wix doesn't expose a service->resource mapping through this endpoint,
  // so every appointment service shares whichever staff/resource is
  // bookable first — good enough to make availability appear; a vendor
  // with several distinct staff calendars may want to fix this up later.
  const resource = resources.find((r) => r.bookable);

  const { data: category } = await admin
    .from('activity_categories')
    .select('id')
    .order('sort_order')
    .limit(1)
    .single();

  const result: WixServiceSyncResult = { created: 0, updated: 0, skipped: [] };

  for (const service of services) {
    const type =
      service.type === 'APPOINTMENT' || service.type === 'CLASS' || service.type === 'COURSE'
        ? service.type
        : null;
    if (!type) {
      result.skipped.push({ name: service.name, reason: `Unsupported Wix service type "${service.type}"` });
      continue;
    }
    if (type === 'APPOINTMENT' && !resource) {
      result.skipped.push({ name: service.name, reason: 'No bookable staff/resource found on the Wix account' });
      continue;
    }

    const { data: existing } = await admin
      .from('activities')
      .select('id')
      .eq('provider_id', providerId)
      .eq('wix_service_id', service.id)
      .maybeSingle();

    if (existing) {
      await admin
        .from('activities')
        .update({
          title: service.name,
          wix_service_type: type,
          wix_resource_id: type === 'APPOINTMENT' ? resource!.id : null,
        })
        .eq('id', existing.id);
      result.updated++;
      continue;
    }

    if (!category) {
      result.skipped.push({ name: service.name, reason: 'No activity category exists to assign yet' });
      continue;
    }

    const slug = `${slugify(service.name)}-${service.id.slice(0, 6)}`;
    const { error } = await admin.from('activities').insert({
      slug,
      title: service.name,
      description:
        'Imported from Wix. Finish this listing — category, age range, price and description — then publish it when ready.',
      category_id: category.id,
      provider_id: providerId,
      is_published: false,
      wix_service_id: service.id,
      wix_service_type: type,
      wix_resource_id: type === 'APPOINTMENT' ? resource!.id : null,
    });
    if (error) {
      result.skipped.push({ name: service.name, reason: error.message });
      continue;
    }
    result.created++;
  }

  return result;
}
