import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import { sgToUtcIso } from '@/lib/admin-create-provider';

/**
 * A vendor's waivers & consents and class packs, edited from /admin.
 *
 * Same rows, rules and defaults as the vendor portal's own screens
 * (frontends/vendor: PoliciesManager, PackagesPage), so an admin fixing a listing
 * on a vendor's behalf produces exactly what the vendor would have. Writes use the
 * service role behind requireAdmin (the routes), never the caller's own token.
 */

/** provider_policies and packages.available_until postdate types/database.ts. */
const db = () => createAdminClient() as unknown as SupabaseClient;

/** Wix kinds a pack can't be spent on (the vendor portal hides them from the picker too). */
const PACK_INELIGIBLE_WIX_TYPES = new Set(['EVENT', 'COURSE', 'APPOINTMENT']);

/** The ids that are this vendor's classes, or an error naming the problem. `null`/[] = all classes. */
async function ownActivityIds(providerId: string, ids: unknown, forPacks: boolean): Promise<string[] | null> {
  if (ids == null) return null;
  if (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string')) throw new Error('Classes must be a list of ids.');
  if (ids.length === 0) return null;
  const { data } = await db().from('activities')
    .select('id, wix_service_type, wix_event_id').eq('provider_id', providerId).in('id', ids as string[]);
  const rows = (data ?? []) as { id: string; wix_service_type: string | null; wix_event_id: string | null }[];
  if (rows.length !== new Set(ids).size) throw new Error('One of the chosen classes is not this vendor\'s.');
  if (forPacks && rows.some((r) => r.wix_event_id || PACK_INELIGIBLE_WIX_TYPES.has(r.wix_service_type ?? ''))) {
    throw new Error('Packs can\'t be used on Wix events, courses or appointments — leave those classes out.');
  }
  return [...new Set(ids as string[])];
}

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/* ---------------------------------------------------------------- policies */

export type PolicyInput = {
  title?: string; body?: string | null; document_url?: string | null;
  required?: boolean; activity_ids?: string[] | null; active?: boolean;
};

export async function savePolicy(providerId: string, policyId: string | null, input: PolicyInput) {
  const row: Record<string, unknown> = {};
  if (input.title !== undefined || !policyId) {
    const t = text(input.title);
    if (!t) throw new Error('Give it a title parents will recognise.');
    row.title = t;
  }
  if (input.body !== undefined) row.body = text(input.body);
  if (input.document_url !== undefined) row.document_url = text(input.document_url) || null;
  if (input.required !== undefined) row.required = !!input.required;
  if (input.active !== undefined) row.active = !!input.active;
  // Empty selection = provider-wide (applies to every class), as in the portal.
  if (input.activity_ids !== undefined) row.activity_ids = await ownActivityIds(providerId, input.activity_ids, false);

  if (policyId) {
    const { data, error } = await db().from('provider_policies').update(row)
      .eq('id', policyId).eq('provider_id', providerId).select('id, title').maybeSingle();
    if (error) throw new Error(`Could not save the policy: ${error.message}`);
    if (!data) throw new Error('That policy no longer exists.');
    return data as { id: string; title: string };
  }
  if (row.body === undefined) row.body = '';
  const { data, error } = await db().from('provider_policies')
    .insert({ provider_id: providerId, ...row }).select('id, title').single();
  if (error) throw new Error(`Could not add the policy: ${error.message}`);
  return data as { id: string; title: string };
}

/* ---------------------------------------------------------------- packages */

export type PackageInput = {
  name?: string; credits?: number; price?: number | null;
  /** 'none' | 'days' | 'date' — how long a parent's credits last after buying. */
  expiry_mode?: 'none' | 'days' | 'date'; validity_days?: number | null; expiry_date?: string | null;
  activity_ids?: string[] | null;
  /** 0 = Sunday … 6 = Saturday, as the portal stores it; null = any day. */
  allowed_weekday?: number | null; allowed_start_time?: string | null;
  /** When the pack can be bought — Singapore wall-clock "YYYY-MM-DDTHH:mm", or ''/null for no limit. */
  starts_at?: string | null; available_until?: string | null;
  best_value?: boolean; active?: boolean;
};

export async function savePackage(providerId: string, packageId: string | null, input: PackageInput) {
  const row: Record<string, unknown> = {};
  const isNew = !packageId;

  if (input.name !== undefined || isNew) {
    const n = text(input.name);
    if (!n) throw new Error('Give the pack a name.');
    row.name = n;
  }
  if (input.credits !== undefined || isNew) {
    const c = Number(input.credits);
    if (!Number.isInteger(c) || c < 1) throw new Error('Credits must be a whole number, at least 1.');
    row.credits = c;
  }
  if (input.price !== undefined || isNew) {
    const p = input.price == null ? 0 : Number(input.price);
    if (!Number.isFinite(p) || p < 0) throw new Error('Enter a valid price.');
    row.price_cents = Math.round(p * 100);
  }
  if (input.expiry_mode !== undefined) {
    if (input.expiry_mode === 'days') {
      const d = Number(input.validity_days);
      if (!Number.isInteger(d) || d < 1) throw new Error('Enter how many days the pack stays valid, or choose another expiry.');
      row.validity_days = d; row.expiry_date = null;
    } else if (input.expiry_mode === 'date') {
      const d = text(input.expiry_date);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error('Pick an expiry date.');
      row.expiry_date = d; row.validity_days = null;
    } else {
      row.validity_days = null; row.expiry_date = null;
    }
  }
  if (input.activity_ids !== undefined) row.activity_ids = await ownActivityIds(providerId, input.activity_ids, true);
  if (input.allowed_weekday !== undefined) {
    const w = input.allowed_weekday;
    if (w != null && !(Number.isInteger(w) && w >= 0 && w <= 6)) throw new Error('Unknown day of the week.');
    row.allowed_weekday = w ?? null;
  }
  if (input.allowed_start_time !== undefined) {
    const t = text(input.allowed_start_time);
    if (t && !/^\d{2}:\d{2}$/.test(t)) throw new Error('Start time should look like 09:30.');
    row.allowed_start_time = t || null;
  }
  if (input.starts_at !== undefined) row.starts_at = text(input.starts_at) ? sgToUtcIso(text(input.starts_at)) : null;
  if (input.available_until !== undefined) row.available_until = text(input.available_until) ? sgToUtcIso(text(input.available_until)) : null;
  if (row.starts_at && row.available_until && (row.available_until as string) <= (row.starts_at as string)) {
    throw new Error('"Available until" is before "Available from".');
  }
  if (input.best_value !== undefined) row.best_value = !!input.best_value;
  if (input.active !== undefined) row.active = !!input.active;

  if (packageId) {
    const { data, error } = await db().from('packages').update(row)
      .eq('id', packageId).eq('provider_id', providerId).select('id, name').maybeSingle();
    if (error) throw new Error(`Could not save the pack: ${error.message}`);
    if (!data) throw new Error('That pack no longer exists.');
    return data as { id: string; name: string };
  }
  const { data, error } = await db().from('packages')
    .insert({ provider_id: providerId, ...row }).select('id, name').single();
  if (error) throw new Error(`Could not add the pack: ${error.message}`);
  return data as { id: string; name: string };
}

/** Deletes a pack nobody has bought. A bought pack holds parents' credits, so it can only be paused. */
export async function deletePackage(providerId: string, packageId: string) {
  const { count } = await db().from('package_purchases')
    .select('id', { count: 'exact', head: true }).eq('package_id', packageId);
  if (count) throw new Error(`Parents have bought this pack ${count} time${count === 1 ? '' : 's'}, so it can't be deleted — pause it instead. They keep their credits.`);
  const { data, error } = await db().from('packages').delete()
    .eq('id', packageId).eq('provider_id', providerId).select('id, name').maybeSingle();
  if (error) throw new Error(`Could not delete the pack: ${error.message}`);
  if (!data) throw new Error('That pack no longer exists.');
  return data as { id: string; name: string };
}
