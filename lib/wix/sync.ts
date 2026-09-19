import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import {
  fetchWixServices,
  fetchWixResources,
  fetchWixLocations,
  fetchWixAvailability,
  fetchWixClassSessions,
  fetchWixClassSessionList,
  fetchWixSessionLiveness,
  fetchWixCourseSpan,
  fetchWixConfirmedAppointmentBookings,
  createWixBooking,
  createWixClassBooking,
  fetchWixBookingRevision,
  cancelWixBooking,
  rescheduleWixClassBooking,
  decodeWixSlotKey,
  encodeWixSlotKey,
  courseAnchorSlotKey,
  wixServicePrice,
  wixServiceCapacity,
  wixServiceImageUrl,
  wixLocalToUtcIso,
  wixSlotStaff,
  formatWixStaffNames,
  selectNonOverlappingSlots,
  WIX_AVAILABILITY_WINDOW_DAYS,
  type WixCredentials,
  type WixSlotKey,
  type WixService,
  type WixLocation,
  type WixClassSession,
  type WixTimeSlot,
  type WixConfirmedBooking,
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

/** A Wix service carries its own address via `service.locations` — its
 *  BUSINESS-type entry if it has one, else its CUSTOM-type entry (a one-off
 *  address the vendor set for that specific service, e.g. a camp held
 *  somewhere other than their registered business address). Either way that
 *  nested object has no name — only id/type/address. BUSINESS ids are
 *  cross-referenced against a `fetchWixLocations()` lookup (the dedicated
 *  Locations query, which does have a name) to name it properly; CUSTOM ids
 *  never appear in that lookup (Wix's Locations endpoint only returns
 *  BUSINESS), so those fall back to the formatted address itself. Either way
 *  we find-or-create the matching provider_locations row keyed on
 *  wix_location_id so multiple services at the same address share one row
 *  instead of a duplicate per service. Returns nulls when the service has
 *  neither (e.g. CUSTOMER-location appointment services) — that's not a
 *  failure, just nothing to link. */
async function resolveWixServiceLocation(
  admin: SupabaseClient<Database>,
  providerId: string,
  service: WixService,
  wixLocationsById: Map<string, WixLocation>,
  cache: Map<string, string | null>
): Promise<{ locationId: string | null; address: string | null; postalCode: string | null }> {
  const loc =
    service.locations?.find((l) => l.type === 'BUSINESS') ??
    service.locations?.find((l) => l.type === 'CUSTOM');
  if (!loc) return { locationId: null, address: null, postalCode: null };

  const known = wixLocationsById.get(loc.id);
  const address = known?.address ?? loc.calculatedAddress?.formattedAddress ?? null;
  const postalCode = known?.postalCode ?? loc.calculatedAddress?.postalCode ?? null;

  if (cache.has(loc.id)) return { locationId: cache.get(loc.id)!, address, postalCode };

  const { data: existing } = await admin
    .from('provider_locations')
    .select('id')
    .eq('provider_id', providerId)
    .eq('wix_location_id', loc.id)
    .maybeSingle();
  if (existing) {
    cache.set(loc.id, existing.id);
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
      name: known?.name ?? address ?? 'Wix location',
      address,
      postal_code: postalCode,
      wix_location_id: loc.id,
      is_primary: (count ?? 0) === 0,
    })
    .select('id')
    .single();
  cache.set(loc.id, created?.id ?? null);
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
  // Every APPOINTMENT/CLASS/COURSE this run touches (create or update),
  // collected for the availability pass below — see the comment there for
  // why this exists at all: date/time/duration used to depend entirely on
  // some parent happening to open this exact activity's detail page first.
  const activitiesForAvailabilitySync: WixSlotActivity[] = [];

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
        // image_source rides along with image_urls (same key, same "did Wix
        // actually give a photo this sync" gate) so a service that gets its
        // first Wix photo after being created photo-less also starts
        // showing it, instead of staying stuck behind the provider's default
        // forever. Never set back to 'profile' here — only new imports (see
        // above) start there; an existing 'custom' activity keeps showing
        // its own photo even if Wix briefly reports none (imageUrl null just
        // omits both keys, same as always).
        ...(imageUrl ? { image_urls: [imageUrl], image_source: 'custom' as const } : {}),
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
          // image_source has no lock of its own — it only ever rides along
          // with image_urls (see above), so dropping a locked image_urls
          // must drop the paired image_source too, or a vendor's own photo
          // choice would still get silently flipped to 'custom' every sync.
          if (field === 'image_urls') delete patch.image_source;
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
      activitiesForAvailabilitySync.push({
        id: existing.id,
        wix_service_id: service.id,
        wix_resource_id: type === 'APPOINTMENT' ? resource!.id : null,
        wix_service_type: type,
      });
      continue;
    }

    if (!category) {
      result.skipped.push({ name: service.name, reason: 'No activity category exists to assign yet' });
      continue;
    }

    const slug = `${slugify(service.name)}-${service.id.slice(0, 6)}`;
    // No real Wix description on first import: leave it empty rather than
    // the old "Imported from Wix. Finish this listing..." placeholder, which
    // parents could see verbatim on an activity a vendor published without
    // noticing it. Same policy as images (below) — an empty own value falls
    // back to the provider's own description on the parent-facing detail
    // page (App.tsx's InfoBlock), not a canned stand-in.
    const description = wixDescription || '';
    const { data: inserted, error } = await admin
      .from('activities')
      .insert({
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
        // 'custom' when Wix actually gave a photo, so resolveActivityImages
        // shows it instead of being silently outranked by the provider's own
        // catalogue (the 'profile' default always wins over an activity's
        // own image_urls, regardless of whether they're empty) — same
        // "own value first, provider default only when there's nothing"
        // policy this ticket asked for. 'profile' (never set on updates,
        // see the patch above) is correct as the starting point when Wix has
        // no photo yet, so a provider default shows until one exists.
        image_source: imageUrl ? 'custom' : 'profile',
      })
      .select('id')
      .single();
    if (error || !inserted) {
      result.skipped.push({ name: service.name, reason: error?.message ?? 'insert returned no row' });
      continue;
    }
    result.created++;
    activitiesForAvailabilitySync.push({
      id: inserted.id,
      wix_service_id: service.id,
      wix_resource_id: type === 'APPOINTMENT' ? resource!.id : null,
      wix_service_type: type,
    });
  }

  // Every touched APPOINTMENT/CLASS/COURSE gets its near-term availability
  // pulled and materialized into activity_sessions right here — this used to
  // be the one thing "Sync services" (and the 15-min scheduled sync) never
  // did: price/capacity/location/photo/description were kept in step, but a
  // freshly-imported (or long-unvisited) Wix service's actual date/time/
  // duration stayed genuinely blank until some parent happened to open that
  // exact activity's detail page — the only other caller of
  // syncWixActivityAvailability (app/api/wix/slots/route.ts). Concurrent
  // across activities (allSettled) since each is an independent Wix fetch
  // with no shared state, unlike the serial per-service loop above — one
  // activity's Wix hiccup (or a slow response) can't hold up or fail the
  // rest. A COURSE gets the same wide 60-day window app/api/wix/slots/
  // route.ts always forces for it (it's typically booked well ahead and
  // reviewed far less often); everything else gets 14 days — enough to
  // cover what Explore/the vendor's own preview show without fetching a
  // full 60-day appointment book on every 15-minute cron tick.
  const availabilitySettled = await Promise.allSettled(
    activitiesForAvailabilitySync.map((a) =>
      syncWixActivityAvailability(admin, a, creds, a.wix_service_type === 'COURSE' ? 60 : 14)
    )
  );
  availabilitySettled.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error('Wix availability sync failed for activity', activitiesForAvailabilitySync[i].id, r.reason);
    }
  });

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
 * Deleted in bulk where it's safe to, falling back to one row at a time only
 * for rows that need it: `bookings.session_id` has no cascade, so a session
 * with even a *cancelled* booking against it (not counted as "booked" here,
 * but still FK-referenced) fails to delete — a single bulk statement is one
 * transaction, so one such row in the batch would roll back every row in it,
 * not just itself. Those go through individually and swallow their own
 * failure; everything else (the common case — an appointment service's
 * unbooked slots have no booking row at all) goes in chunked bulk deletes
 * instead of a per-row round trip, which is what made this take minutes on a
 * half-hourly appointment service with hundreds of materialized slots across
 * the 60-day window.
 *
 * A session created in the last few minutes is never swept, "unbooked" or
 * not — createWixBookingAndSession (lib/wix/sync.ts) creates the real
 * reservation in Wix and materializes this row FIRST, and only afterwards
 * does the calling route insert the local `bookings` row (the free and
 * redeem-package routes) — there is a real gap where a booking is
 * genuinely in flight but no local `bookings` row references this session
 * yet. Confirmed against production data: a vendor unchecking this same
 * activity in the Import picker while a parent's redeem-package request was
 * mid-flight deleted the just-created course anchor before its booking row
 * landed, leaving a real, confirmed Wix booking with no local trace at all
 * (the parent's payment/credit spend and the roster both silently lost it).
 * A short grace window costs nothing — a truly unbooked session created
 * minutes ago is swept on the very next unlink anyway.
 */
async function deleteUnbookedSessions(admin: SupabaseClient<Database>, activityId: string): Promise<void> {
  const graceCutoff = new Date(Date.now() - 10 * 60_000).toISOString();
  const { data: sessions } = await admin
    .from('activity_sessions')
    .select('id, capacity, wix_slot_key, wix_remaining_capacity')
    .eq('activity_id', activityId)
    .neq('status', 'cancelled')
    .lt('created_at', graceCutoff);
  if (!sessions || sessions.length === 0) return;

  const sessionIds = sessions.map((s) => s.id);
  const { data: bookings } = await admin
    .from('bookings')
    .select('session_id, status')
    .in('session_id', sessionIds);
  const activeBookedIds = new Set<string>();
  const anyBookingIds = new Set<string>();
  for (const b of bookings ?? []) {
    anyBookingIds.add(b.session_id);
    if (b.status !== 'cancelled') activeBookedIds.add(b.session_id);
  }

  const bulkDeletable: string[] = [];
  const deleteIndividually: string[] = [];
  for (const s of sessions) {
    if (activeBookedIds.has(s.id)) continue;
    const bookedOnWix = !!s.wix_slot_key && s.wix_remaining_capacity != null && s.capacity != null && s.wix_remaining_capacity < s.capacity;
    if (bookedOnWix) continue;
    (anyBookingIds.has(s.id) ? deleteIndividually : bulkDeletable).push(s.id);
  }

  // Chunked for the same request-url-length reason importWixSessionStaff
  // chunks its own `.in(...)` deletes.
  for (let i = 0; i < bulkDeletable.length; i += 500) {
    await admin.from('activity_sessions').delete().in('id', bulkDeletable.slice(i, i + 500));
  }
  for (const id of deleteIndividually) {
    await admin.from('activity_sessions').delete().eq('id', id);
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

/** Everything {@link cancelWixDroppedSession} needs to prove Wix really dropped
 *  a session. `listComplete` is whether the calendar read that produced the
 *  "current keys" saw every page (see fetchWixClassSessionList): absence from a
 *  truncated list proves nothing. */
export interface WixDroppedSessionContext {
  creds: WixCredentials;
  listComplete: boolean;
}

/** A vendor cancelling a class occurrence on Wix leaves no marker in the list
 *  we sync — the session just stops being returned. Until now that was treated
 *  as "keep it if anyone booked", so the booking, the parent's calendar date
 *  and the vendor's schedule all carried on as if the class still ran.
 *
 *  This is where such a session is finally cancelled, and it is deliberately
 *  conservative because the consequence is emails to real parents. It acts only
 *  when ALL of these hold:
 *    1. the calendar read was complete (never infer a cancellation from a
 *       truncated list),
 *    2. the occurrence is still in the future (a class that already happened
 *       and later fell out of the window is history, not a cancellation),
 *    3. it is a class-occurrence key (not an appointment slot, not a course
 *       anchor), and
 *    4. Wix, asked about that exact session, says it is cancelled or gone —
 *       not merely "absent from a list". An inconclusive answer (timeout, 5xx,
 *       odd status) does nothing; the next sync simply tries again.
 *  The cancel itself is one database function (cancel_wix_session, migration
 *  00146) so the bookings, notifications, emails and make-up credit all go
 *  through the same triggers a vendor's own portal cancellation uses. */
export async function cancelWixDroppedSession(
  admin: SupabaseClient<Database>,
  session: { id: string; wix_slot_key: string; starts_at: string },
  ctx: WixDroppedSessionContext
): Promise<void> {
  if (!ctx.listComplete) return;
  if (new Date(session.starts_at).getTime() <= Date.now()) return;
  let key: WixSlotKey;
  try {
    key = decodeWixSlotKey(session.wix_slot_key);
  } catch {
    return;
  }
  if (key.kind !== 'class') return;

  const liveness = await fetchWixSessionLiveness(ctx.creds, key.sessionId);
  if (liveness !== 'cancelled') return;

  const { data, error } = await admin.rpc('cancel_wix_session', { p_session_id: session.id });
  if (error) {
    console.error('Wix dropped-session cancel failed', session.id, error);
    return;
  }
  console.log(`Wix cancelled session ${session.id} (${session.starts_at}) — cancelled ${data ?? 0} booking(s)`);
}

/** Removes local `activity_sessions` rows for slots this same fetch's window
 *  covered but Wix no longer offers — the vendor edited their weekly hours,
 *  changed a session's duration, swapped staff, etc., and the old candidate
 *  times (upserted from an earlier fetch, keyed by their own now-defunct
 *  `wix_slot_key`) otherwise linger forever, since upsert only ever adds or
 *  updates, never removes. Scoped to `[windowStart, windowEnd)` — the exact
 *  range this fetch actually queried — so a session further out that a
 *  narrower `days` window simply didn't ask about is never touched. Only
 *  deletes a session with no real booking against it (local or Wix-side) —
 *  a booked slot disappearing from live availability is exactly what a
 *  confirmed booking should do, not grounds for deleting the booking's own
 *  session. Moved here from app/api/wix/slots/route.ts so
 *  syncWixActivityAvailability below can share it. */
async function reconcileStaleWixSessions(
  admin: SupabaseClient<Database>,
  activityId: string,
  currentKeys: Set<string>,
  windowStart: Date,
  windowEnd: Date,
  // Class/course occurrences only: how to prove Wix cancelled a kept session
  // (see cancelWixDroppedSession). Omitted for appointments, whose slots come
  // and go with availability and are never "cancelled" by a vendor this way.
  dropped?: WixDroppedSessionContext
): Promise<void> {
  const { data: existing } = await admin
    .from('activity_sessions')
    .select('id, wix_slot_key, wix_remaining_capacity, capacity, starts_at')
    .eq('activity_id', activityId)
    .not('wix_slot_key', 'is', null)
    // A COURSE enrolment's anchor row (wix_slot_key 'wixcourse:<scheduleId>')
    // isn't one of the per-occurrence slots this fetch enumerates — it spans
    // the whole run and is managed at booking time — so it must never be
    // treated as a stale occurrence and swept.
    .not('wix_slot_key', 'like', 'wixcourse:%')
    // Already cancelled by an earlier pass: settled, and its (cancelled)
    // bookings still reference it so it can never be deleted anyway.
    .neq('status', 'cancelled')
    .gte('starts_at', windowStart.toISOString())
    .lt('starts_at', windowEnd.toISOString());
  const stale = (existing ?? []).filter((s) => !currentKeys.has(s.wix_slot_key!));
  if (stale.length === 0) return;

  const { data: bookings } = await admin
    .from('bookings')
    .select('session_id, status')
    .in('session_id', stale.map((s) => s.id));
  const bookedSessionIds = new Set(
    (bookings ?? []).filter((b) => b.status !== 'cancelled').map((b) => b.session_id)
  );

  for (const s of stale) {
    // Wix's own remaining-capacity snapshot from the last time this slot was
    // fetched is the other signal a real seat is filled (a class booked
    // directly on Wix's own site, not just through BabyBrain).
    const bookedOnWix = s.wix_remaining_capacity != null && s.capacity != null && s.wix_remaining_capacity < s.capacity;
    const hasLocalBooking = bookedSessionIds.has(s.id);
    if (!hasLocalBooking && !bookedOnWix) {
      await admin.from('activity_sessions').delete().eq('id', s.id);
      continue;
    }
    // Kept for a real local booking, but Wix no longer offers this occurrence
    // at all (the vendor dropped the day, changed the recurrence, cancelled it,
    // etc.) — so wix_remaining_capacity is now a frozen snapshot from before
    // that happened, not live truth, and nothing will ever refresh it again
    // since future fetches simply won't see this slot to upsert. Left alone it
    // permanently overstates "booked" on the vendor's capacity badge
    // (computeWixAwareCapacity takes the max of this and the local held
    // count). Clearing it makes the badge fall back to the local held count,
    // the only figure still honest once Wix itself has stopped tracking it.
    if (hasLocalBooking && s.wix_remaining_capacity != null) {
      await admin.from('activity_sessions').update({ wix_remaining_capacity: null }).eq('id', s.id);
    }
    // Kept rather than deleted — but if Wix confirms the vendor cancelled it,
    // cancel it here too: the parents' bookings, their emails, and the
    // session's visibility all follow from that.
    if (dropped) {
      await cancelWixDroppedSession(admin, s as { id: string; wix_slot_key: string; starts_at: string }, dropped);
    }
  }
}

/** A vendor moving an already-booked APPOINTMENT's time on Wix has no stable
 *  per-slot id to upsert against (unlike a CLASS session — see
 *  syncWixActivityAvailability below): `wix_slot_key` is derived from the
 *  slot's own start/end/location, so a reschedule changes the key. The
 *  ordinary upsert then inserts a brand-new row at the new time, and
 *  reconcileStaleWixSessions is deliberately guarded from deleting the old,
 *  still-booked one (line ~699) — so the booking silently kept pointing at a
 *  session row with the WRONG time forever, and `on_session_rescheduled`
 *  (00126_session_change_notify_location.sql) never fired: no update ever
 *  touched `starts_at` on the row the booking actually references, so no
 *  email went out.
 *
 *  Fixes that by matching on the one thing that IS stable across a Wix
 *  reschedule — the booking's own id — rather than on time: cross-checks
 *  every locally-booked Wix appointment session against Wix's current
 *  confirmed-booking record for that same `wix_booking_id`, and updates the
 *  row in place when Wix's time has moved. That's a real `UPDATE ... SET
 *  starts_at = ...` on the exact row the booking references, which both
 *  corrects the booking's data and fires the trigger. Run before the
 *  key-based upsert below so a subsequent read of "what's actually booked"
 *  reflects the correction. */
async function reconcileRescheduledWixAppointments(
  admin: SupabaseClient<Database>,
  activityId: string,
  confirmedBookings: WixConfirmedBooking[]
): Promise<void> {
  const wixTimeByBookingId = new Map(confirmedBookings.map((b) => [b.id, b]));
  if (wixTimeByBookingId.size === 0) return;

  const { data: rows } = await admin
    .from('bookings')
    .select('wix_booking_id, activity_sessions!inner(id, activity_id, starts_at, ends_at)')
    .eq('activity_sessions.activity_id', activityId)
    .not('wix_booking_id', 'is', null)
    .in('status', ['pending', 'confirmed', 'waitlisted']);

  for (const row of rows ?? []) {
    const wixBookingId = row.wix_booking_id as string | null;
    if (!wixBookingId) continue;
    const wix = wixTimeByBookingId.get(wixBookingId);
    // Not currently a CONFIRMED booking on Wix (cancelled there, etc.) —
    // out of scope for this reconciliation.
    if (!wix) continue;

    const session = row.activity_sessions as unknown as {
      id: string; activity_id: string; starts_at: string; ends_at: string;
    };
    if (
      new Date(wix.start).getTime() === new Date(session.starts_at).getTime() &&
      new Date(wix.end).getTime() === new Date(session.ends_at).getTime()
    ) continue;

    const { error } = await admin
      .from('activity_sessions')
      // wix_slot_key must move too, not just the times: the key this row
      // still carries encodes its OLD (start, end, location) — and now that
      // the booking has moved off that time, Wix reports it as bookable
      // again, so the ordinary key-matched upsert a few lines below would
      // immediately overwrite this correction right back to the old time
      // (confirmed happening in practice before this line was added). A
      // colon can't appear in encodeWixSlotKey's base64url output, so this
      // prefix can never collide with a real slot key — same trick as
      // courseAnchorSlotKey's `wixcourse:` — and it's stable across repeat
      // reschedules of the same booking (next time, this key already reads
      // `wixbooking:<id>`, so this only ever writes once per booking).
      .update({ starts_at: wix.start, ends_at: wix.end, wix_slot_key: `wixbooking:${wixBookingId}` })
      .eq('id', session.id);
    if (error) console.error('Wix appointment reschedule reconcile failed', session.id, error);
  }
}

export type WixAvailabilitySyncResult =
  | { kind: 'class'; sessions: WixClassSession[]; courseSpan: { start: string; end: string } | null }
  | { kind: 'appointment'; slots: WixTimeSlot[] };

/** Fetches one activity's live Wix availability and upserts it into
 *  activity_sessions — branching the same way app/api/wix/slots/route.ts's
 *  GET handler does (APPOINTMENT via the time-slots API, CLASS/COURSE via
 *  the calendar/sessions API), because this *is* that route's own logic,
 *  extracted so a second caller can run it too instead of copying it a
 *  second time (see the module doc on syncWixServicesToActivities for why
 *  a Wix-linked activity's schedule was never proactively kept in step:
 *  only a parent or vendor actually opening this one activity ever
 *  triggered it before now).
 *
 *  Throws on a genuine Wix/DB failure — the route wants to turn that into a
 *  502, while a caller syncing many activities at once wants to catch it
 *  per-activity (Promise.allSettled) so one account's Wix hiccup doesn't
 *  sink the rest. Neither concern belongs in here. */
export async function syncWixActivityAvailability(
  admin: SupabaseClient<Database>,
  activity: WixSlotActivity,
  creds: WixCredentials,
  days: number
): Promise<WixAvailabilitySyncResult> {
  const isClass = activity.wix_service_type === 'CLASS' || activity.wix_service_type === 'COURSE';
  if (!isClass && !activity.wix_resource_id) {
    throw new Error('Activity is not linked to a bookable Wix service');
  }

  const windowStart = new Date();
  const windowEnd = new Date(windowStart.getTime() + days * 24 * 60 * 60 * 1000);
  // Fetched alongside availability rather than before it so it costs no
  // extra wall-clock time — a failure just means sessions keep whatever
  // staff name they already had.
  const staffIdsPromise: Promise<Set<string> | null> = fetchWixResources(creds)
    .then((rs) => new Set(rs.filter((r) => r.bookable).map((r) => r.id)))
    .catch(() => null);

  if (isClass) {
    const [sessionList, knownStaffIds] = await Promise.all([
      fetchWixClassSessionList(creds, activity.wix_service_id, days),
      staffIdsPromise,
    ]);
    const sessions = sessionList.sessions;
    const staffBySlotKey = new Map(
      sessions.map((s) => [
        encodeWixSlotKey({ kind: 'class', sessionId: s.id }),
        formatWixStaffNames(s.staff, knownStaffIds ?? undefined),
      ])
    );

    // A COURSE is enrolled as one whole run — callers that show a
    // "Runs <start> – <end>" span need Wix's real schedule bounds, since
    // `sessions` only holds *future* occurrences (a course mid-run, or one
    // down to its last session, would otherwise understate the span).
    let courseSpan: { start: string; end: string } | null = null;
    if (activity.wix_service_type === 'COURSE') {
      try {
        const span = await fetchWixCourseSpan(creds, activity.wix_service_id);
        if (span.start && span.end) courseSpan = { start: span.start, end: span.end };
      } catch (e) {
        console.error('Wix course span lookup failed', e);
      }

      // The local whole-run anchor row is written once, at the first booking
      // (ensureLocalWixSession returns an existing row untouched), so it froze
      // at whatever the run was then. A vendor who moves the course in Wix
      // afterwards left every booking on it showing — and every reminder and
      // cut-off keyed off — the old dates. Wix's own bounds are the source of
      // truth, so bring the anchor back in step whenever they differ. Never
      // throws: a failed refresh must not break availability.
      if (courseSpan && new Date(courseSpan.start) < new Date(courseSpan.end)) {
        const { error: anchorError } = await admin
          .from('activity_sessions')
          .update({ starts_at: courseSpan.start, ends_at: courseSpan.end })
          .eq('activity_id', activity.id)
          .like('wix_slot_key', 'wixcourse:%')
          .or(`starts_at.neq.${courseSpan.start},ends_at.neq.${courseSpan.end}`);
        if (anchorError) console.error('Wix course anchor refresh failed', anchorError);
      }
    }

    if (sessions.length > 0) {
      const { error: syncError } = await admin.from('activity_sessions').upsert(
        sessions.map((s) => ({
          activity_id: activity.id,
          starts_at: s.start,
          ends_at: s.end,
          capacity: s.capacity,
          wix_remaining_capacity: s.remainingCapacity,
          wix_slot_key: encodeWixSlotKey({ kind: 'class', sessionId: s.id }),
          // Wix lists it as CONFIRMED, so it is running: brings back a session
          // an earlier pass cancelled if the vendor reinstated it. (Bookings
          // cancelled meanwhile stay cancelled; parents simply rebook.)
          status: 'scheduled' as const,
        })),
        { onConflict: 'activity_id,wix_slot_key' }
      );
      if (syncError) console.error('Wix class session sync failed', syncError);
      // After the upsert, so every row it just created/refreshed is there
      // to be named.
      await importWixSessionStaff(admin, activity.id, staffBySlotKey);
    }
    await reconcileStaleWixSessions(
      admin,
      activity.id,
      new Set(sessions.map((s) => encodeWixSlotKey({ kind: 'class', sessionId: s.id }))),
      windowStart,
      windowEnd,
      { creds, listComplete: sessionList.complete }
    );
    return { kind: 'class', sessions, courseSpan };
  }

  const [rawSlots, confirmedBookings, knownStaffIds] = await Promise.all([
    // The resource id is passed so each slot comes back carrying the staff
    // member Wix says is free for it — both to keep this list honest for a
    // multi-staff service and because the booking path relies on the same
    // field (see createWixBooking).
    fetchWixAvailability(creds, activity.wix_service_id, days, [activity.wix_resource_id!]),
    // A slot's own `bookable` flag conflates "a customer holds this time"
    // with every other reason Wix won't offer it to someone new (e.g. the
    // service's minimum-notice booking policy blocking same-day slots) —
    // cross-checking against real confirmed bookings is what actually tells
    // a caller whether a slot is booked vs. simply not offered right now.
    fetchWixConfirmedAppointmentBookings(creds, activity.wix_service_id).catch(() => []),
    staffIdsPromise,
  ]);
  // Fix up any already-booked session Wix has since moved, before anything
  // below treats the new availability as the whole story — see the
  // function's own doc comment for why this can't just be the upsert.
  await reconcileRescheduledWixAppointments(admin, activity.id, confirmedBookings);
  // Wix offers a rolling start time every split-interval (a 45-minute
  // service on a 30-minute split returns 10:00-10:45, 10:30-11:15,
  // 11:00-11:45, ...) — alternative starts for one opening, not distinct
  // appointments. See selectNonOverlappingSlots for the full reasoning.
  const slots = selectNonOverlappingSlots(rawSlots);
  // `b.start` (from the real bookings resource) is a genuine UTC timestamp;
  // comparing it against a slot means first converting that slot's own
  // site-local `localStartDate` the same way.
  const bookedStarts = new Set(confirmedBookings.map((b) => new Date(b.start).toISOString()));
  // An appointment names its staff from the slot's own availableResources —
  // the exact resource createWixBooking then books against — rather than
  // from the activity's stored fallback.
  // See WixSlotKey's own doc comment: two locations offering the same
  // service at the same wall-clock time otherwise collide into one key.
  const appointmentKey = (s: WixTimeSlot) =>
    encodeWixSlotKey({ kind: 'appointment', s: s.localStartDate, e: s.localEndDate, loc: s.location?.id ?? '' });
  const staffBySlotKey = new Map(
    slots.map((s) => [
      appointmentKey(s),
      formatWixStaffNames(wixSlotStaff(s), knownStaffIds ?? undefined),
    ])
  );

  if (slots.length > 0) {
    const { error: syncError } = await admin.from('activity_sessions').upsert(
      slots.map((s) => {
        const startsAtUtc = wixLocalToUtcIso(s.localStartDate, s.timeZone ?? 'UTC');
        const endsAtUtc = wixLocalToUtcIso(s.localEndDate, s.timeZone ?? 'UTC');
        return {
          activity_id: activity.id,
          starts_at: startsAtUtc,
          ends_at: endsAtUtc,
          capacity: 1,
          wix_remaining_capacity: bookedStarts.has(new Date(startsAtUtc).toISOString()) ? 0 : 1,
          // The slot key is Wix's own round-trip identifier — stays the raw
          // site-local strings Wix gave us, since re-fetching availability
          // and creating the actual booking both compare/send this exact
          // same untouched value back to Wix.
          wix_slot_key: appointmentKey(s),
        };
      }),
      { onConflict: 'activity_id,wix_slot_key' }
    );
    if (syncError) console.error('Wix appointment slot sync failed', syncError);
    await importWixSessionStaff(admin, activity.id, staffBySlotKey);
  }
  await reconcileStaleWixSessions(
    admin,
    activity.id,
    new Set(slots.map(appointmentKey)),
    windowStart,
    windowEnd
  );
  return { kind: 'appointment', slots };
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

/**
 * The per-session half of the pause rule (00091) for a Wix slot. The
 * activity-level flag is handled by {@link checkWixBookingGates}; this reads
 * the one thing that flag can't — whether the vendor has closed *this* Wix
 * occurrence specifically. A Wix slot only has a local `activity_sessions`
 * row once someone has viewed or booked it, so "no row" means "not paused".
 * Sync never writes `bookings_paused`, so a pause set from the Schedule
 * calendar survives every re-sync.
 */
export async function isWixSessionPaused(
  admin: SupabaseClient<Database>,
  activityId: string,
  wixSlotId: string
): Promise<boolean> {
  const key = wixSlotId.replace(/^wix:/, '');
  const { data } = await admin
    .from('activity_sessions')
    .select('bookings_paused')
    .eq('activity_id', activityId)
    .eq('wix_slot_key', key)
    .maybeSingle();
  return !!data?.bookings_paused;
}

/**
 * The per-session override of activities.booking_cutoff_minutes (migration
 * 00137) for a Wix slot — same "no local row yet" story as
 * isWixSessionPaused: a slot nobody has viewed/booked yet has nothing to
 * override, so null (the caller falls back to the activity's own cutoff).
 */
export async function getWixSessionBookingCutoff(
  admin: SupabaseClient<Database>,
  activityId: string,
  wixSlotId: string
): Promise<number | null> {
  const key = wixSlotId.replace(/^wix:/, '');
  const { data } = await admin
    .from('activity_sessions')
    .select('booking_cutoff_minutes')
    .eq('activity_id', activityId)
    .eq('wix_slot_key', key)
    .maybeSingle();
  return data?.booking_cutoff_minutes ?? null;
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
      // Location has to match too, not just start/end — a vendor with more
      // than one business location can offer the same appointment service at
      // the same wall-clock time from each (see WixSlotKey's doc comment);
      // matching on start/end alone could resolve a parent's chosen slot to
      // a *different* location's identical-looking one.
      const slot = available.find(
        (s) => s.bookable && s.localStartDate === slotKey.s && s.localEndDate === slotKey.e && (s.location?.id ?? '') === slotKey.loc
      );
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
 * Cancels a Wix-linked booking in Wix itself, given the `wix_booking_id`
 * stamped on it at creation. `cancel_booking`/`cancel_booking_group`
 * (supabase/migrations/00099) only ever flip the local `bookings.status` —
 * this is the piece that actually frees the seat back up on Wix's calendar.
 * A booking with no `wix_booking_id` (a non-Wix activity) isn't this
 * function's problem — callers only reach for this once they already know
 * the activity is Wix-linked.
 */
export async function cancelWixLinkedBooking(
  creds: WixCredentials,
  wixBookingId: string
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  try {
    const revision = await fetchWixBookingRevision(creds, wixBookingId);
    if (revision == null) {
      // Wix has no record of this booking any more (already cancelled there
      // by the vendor, or the account's changed since) — nothing to cancel,
      // and the local cancellation should proceed rather than block on it.
      return { ok: true };
    }
    await cancelWixBooking(creds, wixBookingId, revision);
    return { ok: true };
  } catch (e) {
    console.error('Wix booking cancellation failed', wixBookingId, e);
    return { ok: false, status: 502, error: 'Could not cancel this booking in Wix — please try again' };
  }
}

/**
 * Moves a Wix-linked CLASS booking to a different occurrence of the same
 * class in Wix itself, given the `wix_booking_id` stamped on it at creation
 * and the `activity_sessions` row the parent is moving to.
 * `reschedule_booking` (supabase/migrations/00091) only ever moved the local
 * `bookings.session_id` — this is the piece that actually moves the Wix
 * calendar entry, so the old occurrence frees up and the new one shows the
 * seat as taken.
 *
 * Only ever called for a CLASS-type Wix service — see
 * {@link rescheduleWixClassBooking}'s own doc for why APPOINTMENT and
 * COURSE aren't handled here. `newSession.wix_slot_key` must decode to a
 * `{kind:'class'}` key; anything else (a non-Wix session, a COURSE anchor
 * row) is a caller bug, not a Wix-side failure, so it's rejected before any
 * Wix call is made.
 */
export async function rescheduleWixClassBookingToSession(
  creds: WixCredentials,
  wixServiceId: string,
  wixBookingId: string,
  newSession: { wix_slot_key: string | null }
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  if (!newSession.wix_slot_key) {
    return { ok: false, status: 400, error: 'That session is not linked to Wix' };
  }
  let sessionId: string;
  try {
    const decoded = decodeWixSlotKey(newSession.wix_slot_key);
    if (decoded.kind !== 'class') return { ok: false, status: 400, error: 'That session is not linked to Wix' };
    sessionId = decoded.sessionId;
  } catch {
    return { ok: false, status: 400, error: 'That session is not linked to Wix' };
  }

  try {
    // Re-fetched live rather than trusted from whenever this local session
    // row was created — the same "never trust stale slot data" rule
    // resolveWixSlot follows for a brand-new booking, and the only way to
    // get the target occurrence's `eventId` (see rescheduleWixClassBooking's
    // own doc for why that's a different value from `wix_slot_key`).
    const sessions = await fetchWixClassSessions(creds, wixServiceId, WIX_AVAILABILITY_WINDOW_DAYS);
    const live = sessions.find((s) => s.id === sessionId);
    if (!live) {
      return { ok: false, status: 409, error: 'That class occurrence is no longer available on Wix' };
    }

    const revision = await fetchWixBookingRevision(creds, wixBookingId);
    if (revision == null) {
      return { ok: false, status: 409, error: 'This booking is no longer found on Wix — contact support' };
    }
    await rescheduleWixClassBooking(creds, wixBookingId, revision, live.eventId);
    return { ok: true };
  } catch (e) {
    console.error('Wix booking reschedule failed', wixBookingId, e);
    return { ok: false, status: 502, error: 'Could not move this booking in Wix — please try again' };
  }
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
