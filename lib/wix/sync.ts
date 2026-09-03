import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import {
  fetchWixServices,
  fetchWixResources,
  fetchWixLocations,
  fetchWixAvailability,
  fetchWixClassSessions,
  fetchWixCourseSpan,
  createWixBooking,
  createWixClassBooking,
  decodeWixSlotKey,
  courseAnchorSlotKey,
  wixServicePrice,
  wixServiceCapacity,
  wixServiceImageUrl,
  wixLocalToUtcIso,
  WIX_AVAILABILITY_WINDOW_DAYS,
  type WixCredentials,
  type WixService,
  type WixLocation,
  type WixClassSession,
  type WixTimeSlot,
} from './client';

/**
 * Turns every service on a vendor's connected Wix account (appointment or
 * class/course) into a local activities row, so nothing on their Wix
 * account has to be re-entered by hand to show up on BabyBrain.
 *
 * Safe to call repeatedly — matched on (provider_id, wix_service_id), so a
 * re-sync after new Wix services are added only creates the new ones.
 * Existing rows only get their name/resource kept in step; whatever the
 * vendor has since edited on BabyBrain itself (category, age range, publish
 * state) is left alone rather than being silently overwritten. Price,
 * capacity, location, photo and description are the exceptions that *are*
 * kept in step on every sync — Wix stays the source of truth for them, same
 * as a vendor's actual Wix dashboard. Each is only overwritten when Wix has
 * a definite value to give; see {@link wixServicePrice} and
 * {@link wixServiceCapacity}.
 *
 * New rows land unpublished (activities.is_published defaults to false) —
 * imported straight from Wix, a listing has no category or age range a
 * parent could search by, so it needs a vendor's review before it goes live
 * on the marketplace.
 *
 * Also reconciles which already-linked activities Wix still actually knows
 * about: any activity whose wix_service_id isn't in this fetch gets marked
 * `wix_missing_since` (and force-unpublished) — covers both a service
 * deleted on Wix and the vendor swapping in an API key for a different
 * site/account. Unlike {@link unlinkWixActivities}, this never clears
 * wix_service_id, so the very next sync that finds the same id again (the
 * right account gets reconnected, or the service comes back) clears it
 * automatically — see the reconciliation pass at the end of this function.
 */

export interface WixServiceSyncResult {
  created: number;
  updated: number;
  skipped: { name: string; reason: string }[];
  /** Previously-linked activities whose wix_service_id disappeared from this
   *  fetch — now `wix_missing_since`-flagged and unpublished. */
  removed: number;
  /** The reverse: activities that were `wix_missing_since`-flagged and whose
   *  service reappeared in this fetch — flag cleared. */
  revived: number;
}

/** A Wix service carries its own address via `service.locations` (its
 *  BUSINESS-type entry), but that nested object has no name — only
 *  id/type/address. Cross-referenced against a `fetchWixLocations()` lookup
 *  (the dedicated Locations query, which does have a name) to name it
 *  properly, find-or-creating the matching provider_locations row keyed on
 *  wix_location_id so multiple services at the same address share one row
 *  instead of a duplicate per service. Returns nulls when the service has no
 *  BUSINESS location (e.g. CUSTOMER-location appointment services) — that's
 *  not a failure, just nothing to link. */
async function resolveWixServiceLocation(
  admin: SupabaseClient<Database>,
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

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'wix-service';
}

/** The only Wix-owned columns a vendor may claim via activities.wix_locked_fields
 *  (00082). Price is the one the portal offers today; title/description/image
 *  are listed because they are the intended next step and the mechanism is
 *  identical. Capacity, location and the schedule are deliberately absent —
 *  those have correctness consequences (a seat Wix will refuse to sell, a
 *  family sent to the wrong address), not just commercial ones. */
const VENDOR_OVERRIDABLE_WIX_FIELDS = new Set(['price', 'title', 'description', 'image_urls']);

export async function syncWixServicesToActivities(
  admin: SupabaseClient<Database>,
  providerId: string,
  creds: WixCredentials,
  options?: { onlyServiceIds?: string[] }
): Promise<WixServiceSyncResult> {
  const [services, resources, wixLocations] = await Promise.all([
    fetchWixServices(creds),
    fetchWixResources(creds),
    // A failure here shouldn't sink the whole service sync — activities
    // just come in without a location, same as before this existed.
    fetchWixLocations(creds).catch(() => [] as WixLocation[]),
  ]);
  const bookableResources = resources.filter((r) => r.bookable);
  /** The staff/resource to book an appointment service against. A service
   *  carries its own `staffMemberIds`, and those ids are the resource ids —
   *  so prefer a bookable resource that's actually on this service. Falling
   *  straight to "first bookable resource on the account" (what this used to
   *  do unconditionally) silently picks an unrelated staff member on any
   *  account with more than one, and Wix then rejects every booking against
   *  that service with SLOT_NOT_AVAILABLE. The global fallback is kept only
   *  for a service with no staff assigned at all, where it's still the best
   *  guess available. */
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

  // Creation is opt-in. `onlyServiceIds` is the set of services the "Import
  // specific activities" picker wants turned into activities — the ONLY way
  // a Wix service becomes a listing here. A blanket caller (the "Sync
  // services" button, the pg_cron background sync) passes nothing: those
  // runs refresh and reconcile the activities a vendor has *already*
  // imported, but never create new ones, so connecting an account — or
  // just leaving it connected — no longer pulls the vendor's whole Wix
  // catalogue in behind their back.
  const explicitIds = options?.onlyServiceIds ? new Set(options.onlyServiceIds) : null;

  // One read up front instead of a per-service maybeSingle() — also lets
  // the loop cheaply skip a service that's neither already imported nor
  // being imported right now.
  const { data: linkedRows } = await admin
    .from('activities')
    .select('id, wix_service_id, wix_missing_since, wix_locked_fields')
    .eq('provider_id', providerId)
    .not('wix_service_id', 'is', null);
  const linkedByServiceId = new Map(
    (linkedRows ?? []).map((r) => [r.wix_service_id as string, r])
  );

  for (const service of services) {
    const existing = linkedByServiceId.get(service.id) ?? null;
    const mayCreate = !!explicitIds && explicitIds.has(service.id);
    // Not imported, and not part of an explicit import request — leave it
    // untouched. This is what makes import selective rather than
    // "everything on the account, always".
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

    // Kept in step on every sync (create and update alike) — unlike
    // category/age/price/description, a Wix-linked activity's location
    // isn't something a vendor sets by hand here; Wix stays the source of
    // truth for it.
    const { locationId, address, postalCode } = await resolveWixServiceLocation(
      admin, providerId, service, wixLocationsById, locationCache
    );
    // null means Wix has no single number for this service (varied/custom
    // rate) — leave whatever price is already on the activity alone rather
    // than blanking out a vendor-entered value.
    const price = wixServicePrice(service);
    // Same reasoning for capacity — null means Wix didn't give one (e.g. an
    // appointment service), so an existing vendor-set value is left alone.
    const capacity = wixServiceCapacity(service);
    // The photo is kept in step on every sync — a vendor who updates their
    // cover shot on Wix expects "Sync services" to pick it up, not just the
    // very first import.
    const imageUrl = wixServiceImageUrl(service);
    // Same for description, despite the comment this used to carry: a
    // vendor editing their description on Wix (not on BabyBrain) expects a
    // re-sync to bring the update in, same as the photo. Null (Wix has
    // nothing to give) leaves whatever's already stored alone rather than
    // blanking it — the placeholder below is only ever used on first import.
    const wixDescription = service.description?.trim() || null;

    if (existing) {
      const patch: Database['public']['Tables']['activities']['Update'] = {
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
        // Wix knows about this service again (this fetch found it), so any
        // earlier "gone missing" flag no longer applies.
        wix_missing_since: null,
      };
      // Anything the vendor has claimed (00082) is theirs — drop it from the
      // patch so this sync leaves it alone. Only ever the fields the portal
      // actually offers: a stray value can't be used to stop the reconciler
      // clearing wix_missing_since, or to freeze the service type.
      for (const field of existing.wix_locked_fields ?? []) {
        if (VENDOR_OVERRIDABLE_WIX_FIELDS.has(field)) {
          delete patch[field as keyof typeof patch];
        }
      }
      // Wix's own price is mirrored either way, so an overridden activity can
      // still show what Wix currently charges and be reverted to it.
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
    // Falls back to the old placeholder only here, on first import — a
    // re-sync above always prefers a real Wix description once one exists.
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

  // Anything still linked (wix_service_id set) that this fetch didn't
  // return is no longer on the account BabyBrain is actually connected to
  // right now — either deleted on Wix, or (the case that prompted this)
  // the vendor swapped in an API key for a different site. `services` here
  // is always the *complete* fetch regardless of `onlyServiceIds` (that
  // option only filters which ones get created/updated above), so this
  // reconciliation is accurate even from the "import specific activities"
  // picker's save. Sessions/bookings are left completely alone — only
  // wix_missing_since and is_published change.
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

/**
 * Deletes every session of one activity — past or future — that has no
 * booking against it (locally, or on Wix itself via remaining capacity,
 * however partial: even 1 of 10 filled counts as booked) — called right
 * before an activity is unlinked, so unbooked slots vanish from
 * Schedule/Bookings immediately. Any session with a real booking is
 * preserved regardless of how long ago it happened.
 *
 * Deletes one row at a time and swallows individual failures: `bookings.
 * session_id` has no cascade, so a session with even a *cancelled* booking
 * against it (not counted as "booked" here, but still FK-referenced) would
 * fail to delete — doing this per-row means that one blocked row doesn't
 * roll back the rest.
 */
async function deleteUnbookedSessions(admin: SupabaseClient<Database>, activityId: string): Promise<void> {
  const { data: sessions } = await admin
    .from('activity_sessions')
    .select('id, capacity, wix_slot_key, wix_remaining_capacity')
    .eq('activity_id', activityId)
    .neq('status', 'cancelled');
  if (!sessions || sessions.length === 0) return;

  const sessionIds = sessions.map((s) => s.id);
  const { data: bookings } = await admin
    .from('bookings')
    .select('session_id, status')
    .in('session_id', sessionIds);
  const bookedIds = new Set(
    (bookings ?? []).filter((b) => b.status !== 'cancelled').map((b) => b.session_id)
  );

  for (const s of sessions) {
    if (bookedIds.has(s.id)) continue;
    const bookedOnWix = !!s.wix_slot_key && s.wix_remaining_capacity != null && s.capacity != null && s.wix_remaining_capacity < s.capacity;
    if (bookedOnWix) continue;
    await admin.from('activity_sessions').delete().eq('id', s.id);
  }
}

/**
 * Unchecking a previously-imported service in the "Import specific
 * activities" picker calls this — it deletes that activity's unbooked
 * sessions (past and future), un-publishes it, clears its wix_service_id/
 * type/resource_id so it stops being touched by future syncs, and stamps
 * wix_removed_at (ActivitiesPage hides it once no upcoming — i.e. booked —
 * sessions remain, see that page's `visible` filter). It does NOT delete the
 * activity row itself: activity_sessions/bookings reference activities with
 * `on delete cascade`, so a hard delete here would silently wipe any real
 * booking history against it.
 *
 * The slug gets a `-removed-<id>` suffix so it's out of the way of
 * `activities.slug`'s unique constraint if the vendor re-checks the same
 * service later — sync's insert path uses a slug derived from the Wix
 * service id, which would otherwise collide with this now-orphaned row.
 *
 * Refuses to unlink a service that already has a real (non-cancelled)
 * booking on it, exactly as unlinkWixEventActivities does for Wix Events.
 * Unchecking a box shouldn't be able to strand a family's booked class:
 * clearing wix_service_id detaches it from every future sync, so the seat
 * stops being reconciled against Wix and a later re-import creates an
 * unrelated duplicate listing rather than reviving this one. Those go back
 * in `protectedServices` so the caller can keep them in the sync and tell
 * the vendor why the box came back ticked.
 */
export async function unlinkWixActivities(
  admin: SupabaseClient<Database>,
  providerId: string,
  serviceIds: string[]
): Promise<{ removed: number; protectedServices: { wixServiceId: string; title: string }[] }> {
  if (serviceIds.length === 0) return { removed: 0, protectedServices: [] };

  const { data: rows } = await admin
    .from('activities')
    .select('id, slug, title, wix_service_id')
    .eq('provider_id', providerId)
    .in('wix_service_id', serviceIds);
  if (!rows || rows.length === 0) return { removed: 0, protectedServices: [] };

  let removed = 0;
  const protectedServices: { wixServiceId: string; title: string }[] = [];
  for (const row of rows) {
    const { data: sessions } = await admin.from('activity_sessions').select('id').eq('activity_id', row.id);
    const sessionIds = (sessions ?? []).map((s) => s.id);
    const { count } = sessionIds.length
      ? await admin
          .from('bookings')
          .select('id', { count: 'exact', head: true })
          .in('session_id', sessionIds)
          .neq('status', 'cancelled')
      : { count: 0 };
    if ((count ?? 0) > 0) {
      protectedServices.push({ wixServiceId: row.wix_service_id as string, title: row.title });
      continue;
    }

    await deleteUnbookedSessions(admin, row.id);
    const { error } = await admin
      .from('activities')
      .update({
        is_published: false,
        wix_service_id: null,
        wix_service_type: null,
        wix_resource_id: null,
        wix_removed_at: new Date().toISOString(),
        slug: `${row.slug}-removed-${row.id.slice(0, 6)}`,
      })
      .eq('id', row.id);
    if (!error) removed++;
  }
  return { removed, protectedServices };
}

/**
 * Imports the name of the staff member taking each Wix session onto the
 * local schedule — `activity_sessions.teacher_name`, the same column a
 * non-Wix vendor fills in by hand (00042), so the vendor Schedule calendar,
 * the Activities session list and the parent's booking page all show it
 * without any of them needing to know Wix exists.
 *
 * Called from /api/wix/slots right after that route upserts the session
 * rows, so the name lands in the same pass that materialises the slot —
 * every Wix session on the schedule carries its instructor from the first
 * time anyone looks at it. `staffBySlotKey` maps `wix_slot_key` to the
 * already-formatted display name (see {@link formatWixStaffNames}); for an
 * APPOINTMENT that's the staff Wix says is free for the slot, for a
 * CLASS/COURSE the staff the occurrence is assigned to.
 *
 * A key mapped to null is skipped rather than blanked: Wix simply having
 * nobody named on a session is not an instruction to erase a name that's
 * already there — the same rule {@link wixServicePrice} and
 * {@link wixServiceCapacity} follow for price and capacity.
 *
 * Only rows whose stored name actually differs are written, and those are
 * grouped by name — one UPDATE per instructor who changed, not one per
 * session. That matters because this runs on every slots fetch: a
 * half-hourly appointment service materialises hundreds of rows over the
 * 60-day window, and re-writing all of them on every page view (for a
 * schedule that almost never changes) is pure write load.
 *
 * Both the read and the writes are addressed by `activity_id` and row `id`,
 * never by `wix_slot_key`. PostgREST puts filters in the query string, and
 * these keys are long — a class session's key is a ~460-character base64
 * blob (Wix's own session ids are enormous) — so an `.in('wix_slot_key', …)`
 * over a full window builds a request URL tens of kilobytes long and is
 * rejected before it reaches the database. Comparing in code also sidesteps
 * a second trap: an instructor's name is free text from Wix and can contain
 * the commas and parentheses PostgREST's filter grammar uses as syntax.
 *
 * Best-effort by design — this is display detail on top of availability that
 * has already been fetched and saved, so a failure here logs and returns
 * rather than failing the slots request the vendor or parent is waiting on.
 */
export async function importWixSessionStaff(
  admin: SupabaseClient<Database>,
  activityId: string,
  staffBySlotKey: Map<string, string | null>
): Promise<number> {
  if ([...staffBySlotKey.values()].every((name) => !name)) return 0;

  const { data: rows, error: readError } = await admin
    .from('activity_sessions')
    .select('id, wix_slot_key, teacher_name')
    .eq('activity_id', activityId)
    .not('wix_slot_key', 'is', null);
  if (readError) {
    console.error('Wix session staff import could not read the schedule', activityId, readError);
    return 0;
  }

  const idsByName = new Map<string, string[]>();
  for (const row of rows ?? []) {
    const name = staffBySlotKey.get(row.wix_slot_key as string);
    // `undefined` = this fetch didn't cover the session (a different window);
    // `null` = Wix named nobody. Neither is grounds for a write.
    if (!name || row.teacher_name === name) continue;
    const ids = idsByName.get(name);
    if (ids) ids.push(row.id);
    else idsByName.set(name, [row.id]);
  }
  if (idsByName.size === 0) return 0;

  let updated = 0;
  for (const [name, ids] of idsByName) {
    // Chunked for the same reason the keys aren't used as a filter: an
    // appointment service's first import names every slot in the 60-day
    // window at once, and a few hundred uuids in one `in.(…)` is a request
    // URL long enough to be refused.
    for (let i = 0; i < ids.length; i += 100) {
      const { data, error } = await admin
        .from('activity_sessions')
        .update({ teacher_name: name })
        .in('id', ids.slice(i, i + 100))
        .select('id');
      if (error) {
        console.error('Wix session staff import failed', activityId, error);
        continue;
      }
      updated += data?.length ?? 0;
    }
  }
  return updated;
}

export interface WixSlotActivity {
  id: string;
  wix_service_id: string;
  wix_resource_id: string | null;
  wix_service_type: string | null;
}

/** The booking rules a vendor sets on an activity that a Wix-sourced booking
 *  has to respect just as much as a site-native one does. */
export interface WixBookingGates {
  bookings_paused: boolean | null;
  info_request_enabled: boolean | null;
  booking_cutoff_minutes: number | null;
}

/**
 * The activity-level half of the booking rules, checked before anything is
 * created in Wix.
 *
 * These rules live in `enforce_booking_insert_defaults` (00074) for ordinary
 * bookings, but that trigger opens with `if auth.role() = 'service_role'
 * then return new` — the trusted-server escape hatch the Stripe webhook
 * needs. Every Wix booking route inserts through the service-role admin
 * client, so *none* of them were covered: a class the vendor had paused was
 * still bookable, and an activity that asks for information got a booking
 * with none. The gates have to be applied here instead, in the code that
 * holds the service-role key.
 *
 * The cut-off is deliberately NOT here — it needs the slot's real start
 * time, which only exists once the slot has been resolved against live Wix
 * availability. See {@link resolveWixSlot}'s `gate` argument.
 */
export function checkWixBookingGates(
  gates: WixBookingGates,
  infoResponse: string | null | undefined
): { ok: true } | { ok: false; status: number; error: string } {
  if (gates.bookings_paused) {
    return {
      ok: false,
      status: 409,
      error: 'Bookings for this class are currently paused by the provider.',
    };
  }
  if (gates.info_request_enabled && !infoResponse?.trim()) {
    return {
      ok: false,
      status: 400,
      error: 'This class needs some extra information before you can book.',
    };
  }
  return { ok: true };
}

export interface WixContact {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}

/** Builds the contact BabyBrain hands to Wix when creating a booking on a
 *  parent's behalf. Reads parent_profiles first, falling back to the auth
 *  admin API for anything missing there — needed at Stripe-webhook time,
 *  when there's no request-scoped session to read a logged-in user's email
 *  from directly (unlike the free/credit booking routes, which have one). */
export async function resolveWixContact(admin: SupabaseClient<Database>, userId: string): Promise<WixContact> {
  const { data: parent } = await admin
    .from('parent_profiles')
    .select('full_name, email, phone')
    .eq('id', userId)
    .maybeSingle();
  let email = parent?.email ?? '';
  let fullName = parent?.full_name ?? '';
  if (!email || !fullName) {
    const { data: authUser } = await admin.auth.admin.getUserById(userId);
    email = email || authUser.user?.email || '';
    fullName = fullName || (authUser.user?.user_metadata?.full_name as string | undefined) || '';
  }
  const [firstName, ...rest] = (fullName || 'Parent').trim().split(/\s+/);
  return {
    firstName: firstName || 'Parent',
    lastName: rest.join(' ') || '-',
    email,
    phone: parent?.phone || '',
  };
}

type ResolvedWixSlot =
  | { kind: 'class'; session: WixClassSession }
  | { kind: 'appointment'; slot: WixTimeSlot };

/** Re-validates a chosen slot against *live* Wix availability (never trusts
 *  client-supplied slot times) to close the race where a slot fills between
 *  the picker loading and "Book" being clicked — shared by both the
 *  immediate booking path and the pre-payment reservation path below, since
 *  both need this same check before doing anything else. */
/** How close to a session's start a parent may still book it, or null to
 *  skip the check. Only the routes a *parent* calls pass a number: by the
 *  time finalizeWixBookingCheckout runs, Stripe has already taken the money,
 *  and refusing there over a cut-off that passed while the parent was on
 *  Stripe's page would strand a paid booking rather than prevent a late one. */
type WixCutoffGate = { cutoffMinutes: number | null } | null;

function cutoffRejection(startsAt: string, gate: WixCutoffGate):
  | { status: number; error: string }
  | null {
  if (!gate) return null;
  const cutoff = gate.cutoffMinutes ?? 15;
  if (new Date(startsAt).getTime() - cutoff * 60_000 > Date.now()) return null;
  return {
    status: 409,
    error:
      cutoff === 0
        ? 'This class has already started.'
        : `Bookings for this class close ${cutoff} minutes before it starts.`,
  };
}

async function resolveWixSlot(
  creds: WixCredentials,
  activity: WixSlotActivity,
  wixSlotId: string,
  participants: number,
  gate: WixCutoffGate = null
): Promise<
  | { ok: true; key: string; startsAt: string; endsAt: string; capacity: number; resolved: ResolvedWixSlot }
  | { ok: false; status: number; error: string }
> {
  const isClass = activity.wix_service_type === 'CLASS' || activity.wix_service_type === 'COURSE';
  if (!isClass && !activity.wix_resource_id) {
    return { ok: false, status: 404, error: 'Activity is not linked to a Wix service' };
  }
  // An APPOINTMENT is a 1:1 slot against one specific resource/staff member —
  // there's no "capacity" to split across several children the way a CLASS
  // has real seats. One booking per child, not one booking for several.
  if (!isClass && participants > 1) {
    return { ok: false, status: 400, error: 'This class has one spot per booking — book each child separately.' };
  }

  const key = wixSlotId.slice('wix:'.length);
  const slotKey = decodeWixSlotKey(key);
  if (isClass !== (slotKey.kind === 'class')) {
    return { ok: false, status: 400, error: 'Slot does not match this activity' };
  }

  try {
    if (slotKey.kind === 'class') {
      // Searched over the app's full display window, not the 7-day default:
      // /api/wix/slots shows COURSE occurrences up to 60 days out, and
      // looking a shorter distance here rejected every one of them as "no
      // longer available" despite the parent having just been offered it.
      const sessions = await fetchWixClassSessions(creds, activity.wix_service_id, WIX_AVAILABILITY_WINDOW_DAYS);
      const session = sessions.find((s) => s.id === slotKey.sessionId && s.remainingCapacity >= participants);
      if (!session) {
        return {
          ok: false,
          status: 409,
          error: participants > 1 ? 'Not enough spots left for that many children' : 'That class is no longer available',
        };
      }
      // A COURSE is enrolled as one whole programme — the parent picks an
      // occurrence in the calendar, but the Wix booking (createWixClassBooking
      // with isCourse=true, below) always books the schedule, i.e. every
      // session. So the local anchor row spans the full run and is keyed once
      // per course, not per occurrence: re-enrolling reuses the same row, and
      // "My Bookings" / the confirmation page then show a start–end range
      // straight off it. `resolved.session` still carries the schedule id the
      // Wix call needs.
      if (activity.wix_service_type === 'COURSE') {
        // Prefer Wix's own schedule bounds — `sessions` is future-only, so a
        // course booked mid-run would otherwise anchor to "next remaining
        // session → last" instead of the true run. Falls back to the visible
        // occurrences if the lookup fails.
        let startsAt = sessions.reduce((m, s) => (s.start < m ? s.start : m), session.start);
        let endsAt = sessions.reduce((m, s) => (s.end > m ? s.end : m), session.end);
        try {
          const span = await fetchWixCourseSpan(creds, activity.wix_service_id);
          if (span.start) startsAt = span.start;
          if (span.end) endsAt = span.end;
        } catch (e) {
          console.error('Wix course span lookup failed', e);
        }
        return {
          ok: true,
          key: courseAnchorSlotKey(session.scheduleId),
          startsAt,
          endsAt,
          capacity: session.capacity,
          resolved: { kind: 'class', session },
        };
      }
      // Deliberately only for a CLASS — a COURSE (returned above) is one
      // enrolment in a whole run that a parent may legitimately join
      // mid-way, so neither the run's start nor the next remaining
      // occurrence is a sensible thing to close bookings against.
      const late = cutoffRejection(session.start, gate);
      if (late) return { ok: false, ...late };
      return {
        ok: true,
        key,
        startsAt: session.start,
        endsAt: session.end,
        // The session's actual total capacity, not what's currently remaining
        // — activity_sessions.capacity is meant to be the fixed seat count
        // the local waitlist trigger compares bookings against.
        capacity: session.capacity,
        resolved: { kind: 'class', session },
      };
    } else {
      // Resource ids are requested here so the matched slot carries Wix's own
      // `availableResources` — createWixBooking books against that rather
      // than the activity's stored resource, which is what stops a slot being
      // offered by one staff member and booked against another (a guaranteed
      // SLOT_NOT_AVAILABLE).
      const available = await fetchWixAvailability(creds, activity.wix_service_id, WIX_AVAILABILITY_WINDOW_DAYS, [activity.wix_resource_id]);
      // Deliberately matched against the *unfiltered* availability, not
      // selectNonOverlappingSlots: that filter decides what to *display*, and
      // its grid re-anchors whenever an earlier booking lands. Re-applying it
      // here would reject a slot that is genuinely still bookable just
      // because the canonical grid shifted under it after the parent opened
      // the picker.
      const slot = available.find((s) => s.bookable && s.localStartDate === slotKey.s && s.localEndDate === slotKey.e);
      if (!slot) {
        return { ok: false, status: 409, error: 'That slot is no longer available' };
      }
      // startsAt/endsAt here end up in activity_sessions (ensureLocalWixSession)
      // and must be true UTC — slot.localStartDate/localEndDate themselves stay
      // untouched on `resolved.slot` since createWixBooking sends those exact
      // site-local strings back to Wix's own create-booking call.
      const startsAtUtc = wixLocalToUtcIso(slot.localStartDate, slot.timeZone ?? 'UTC');
      const late = cutoffRejection(startsAtUtc, gate);
      if (late) return { ok: false, ...late };
      return {
        ok: true,
        key,
        startsAt: startsAtUtc,
        endsAt: wixLocalToUtcIso(slot.localEndDate, slot.timeZone ?? 'UTC'),
        capacity: 1,
        resolved: { kind: 'appointment', slot },
      };
    }
  } catch (e) {
    console.error('Wix availability check failed', e);
    return { ok: false, status: 502, error: 'Could not reach Wix' };
  }
}

/** Find-or-create the local activity_sessions row for a resolved slot, keyed
 *  on wix_slot_key — a second parent booking the same class occurrence must
 *  not reset capacity back to "before their booking" on top of the first
 *  parent's already-counted seat. */
async function ensureLocalWixSession(
  admin: SupabaseClient<Database>,
  activityId: string,
  key: string,
  startsAt: string,
  endsAt: string,
  capacity: number
): Promise<string | null> {
  const { data: existingSession } = await admin
    .from('activity_sessions')
    .select('id')
    .eq('activity_id', activityId)
    .eq('wix_slot_key', key)
    .maybeSingle();
  if (existingSession) return existingSession.id;

  const { data: newSession, error } = await admin
    .from('activity_sessions')
    .insert({ activity_id: activityId, starts_at: startsAt, ends_at: endsAt, capacity, wix_slot_key: key })
    .select('id')
    .single();
  if (error || !newSession) {
    console.error('Failed to materialize the local Wix session', error);
    return null;
  }
  return newSession.id;
}

/**
 * Shared middle of every *immediate* "book a Wix slot" flow (free, or paid
 * with a package credit): re-validates against live availability, creates
 * the real booking in Wix, then materializes the local session. Also used
 * to finalize a paid-by-Stripe booking once payment has actually succeeded
 * (see /api/wix/bookings/checkout + the webhook's `wix_booking` handler) —
 * at that point this does exactly what it does for a free booking, just
 * later, so a real Wix reservation only ever gets made once BabyBrain is
 * sure it'll be paid for.
 *
 * Callers only need to decide how the resulting local `bookings` row itself
 * gets created (a free booking, a Stripe-paid one, a package credit, ...).
 */
export async function createWixBookingAndSession(
  admin: SupabaseClient<Database>,
  creds: WixCredentials,
  activity: WixSlotActivity,
  wixSlotId: string,
  contact: WixContact,
  participants = 1,
  /** The activity's booking cut-off, for the parent-facing routes. Left null
   *  by finalizeWixBookingCheckout — see {@link WixCutoffGate}. */
  gate: WixCutoffGate = null
): Promise<
  | { ok: true; sessionId: string; wixBookingId: string }
  | { ok: false; status: number; error: string }
> {
  const resolved = await resolveWixSlot(creds, activity, wixSlotId, participants, gate);
  if (!resolved.ok) return resolved;

  let wixBookingId: string;
  try {
    if (resolved.resolved.kind === 'class') {
      const booking = await createWixClassBooking(
        creds, resolved.resolved.session, contact, participants,
        activity.wix_service_type === 'COURSE'
      );
      wixBookingId = booking.id;
    } else {
      const booking = await createWixBooking(creds, resolved.resolved.slot, activity.wix_resource_id!, contact, participants);
      wixBookingId = booking.id;
    }
  } catch (e) {
    console.error('Wix booking creation failed', e);
    return { ok: false, status: 502, error: 'Could not create the booking in Wix' };
  }

  const sessionId = await ensureLocalWixSession(admin, activity.id, resolved.key, resolved.startsAt, resolved.endsAt, resolved.capacity);
  if (!sessionId) {
    console.error('Booked in Wix but failed to materialize the local session', wixBookingId);
    return { ok: false, status: 500, error: 'Booked in Wix but failed to save locally — contact support' };
  }
  return { ok: true, sessionId, wixBookingId };
}

/**
 * Pre-payment step for a paid Wix-linked class: confirms the slot is still
 * live on Wix and ensures a local activity_sessions row exists for it to
 * attach a pending `bookings` row to — but deliberately does NOT reserve
 * anything on Wix itself yet. The real Wix reservation only happens once
 * Stripe confirms payment (createWixBookingAndSession runs again then, see
 * /api/wix/bookings/checkout), so a parent who starts checkout and never
 * completes it never leaves a live unpaid hold on the vendor's Wix calendar.
 */
export async function reserveWixSlotForCheckout(
  admin: SupabaseClient<Database>,
  creds: WixCredentials,
  activity: WixSlotActivity,
  wixSlotId: string,
  participants = 1,
  gate: WixCutoffGate = null
): Promise<
  | { ok: true; sessionId: string }
  | { ok: false; status: number; error: string }
> {
  const resolved = await resolveWixSlot(creds, activity, wixSlotId, participants, gate);
  if (!resolved.ok) return resolved;

  const sessionId = await ensureLocalWixSession(admin, activity.id, resolved.key, resolved.startsAt, resolved.endsAt, resolved.capacity);
  if (!sessionId) return { ok: false, status: 500, error: 'Could not prepare this session — contact support' };
  return { ok: true, sessionId };
}
