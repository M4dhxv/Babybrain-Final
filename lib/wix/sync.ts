import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import {
  fetchWixServices,
  fetchWixResources,
  fetchWixLocations,
  fetchWixAvailability,
  fetchWixClassSessions,
  createWixBooking,
  createWixClassBooking,
  decodeWixSlotKey,
  wixServicePrice,
  wixServiceCapacity,
  wixServiceImageUrl,
  wixLocalToUtcIso,
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
  // Wix doesn't expose a service->resource mapping through this endpoint,
  // so every appointment service shares whichever staff/resource is
  // bookable first — good enough to make availability appear; a vendor
  // with several distinct staff calendars may want to fix this up later.
  const resource = resources.find((r) => r.bookable);
  const wixLocationsById = new Map(wixLocations.map((l) => [l.id, l]));
  const locationCache = new Map<string, string | null>();

  const { data: category } = await admin
    .from('activity_categories')
    .select('id')
    .order('sort_order')
    .limit(1)
    .single();

  const result: WixServiceSyncResult = { created: 0, updated: 0, skipped: [], removed: 0, revived: 0 };

  // The "Import specific activities" picker calls this with onlyServiceIds
  // set to just the services a vendor checked, instead of every service on
  // the account — everything else about the sync (matching, category
  // assignment, leaving edited fields alone) is identical either way.
  const onlyIds = options?.onlyServiceIds ? new Set(options.onlyServiceIds) : null;

  for (const service of services) {
    if (onlyIds && !onlyIds.has(service.id)) continue;
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
      .select('id, wix_missing_since')
      .eq('provider_id', providerId)
      .eq('wix_service_id', service.id)
      .maybeSingle();

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
      await admin
        .from('activities')
        .update({
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
        })
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
 */
export async function unlinkWixActivities(
  admin: SupabaseClient<Database>,
  providerId: string,
  serviceIds: string[]
): Promise<number> {
  if (serviceIds.length === 0) return 0;

  const { data: rows } = await admin
    .from('activities')
    .select('id, slug')
    .eq('provider_id', providerId)
    .in('wix_service_id', serviceIds);
  if (!rows || rows.length === 0) return 0;

  let removed = 0;
  for (const row of rows) {
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
  return removed;
}

export interface WixSlotActivity {
  id: string;
  wix_service_id: string;
  wix_resource_id: string | null;
  wix_service_type: string | null;
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
async function resolveWixSlot(
  creds: WixCredentials,
  activity: WixSlotActivity,
  wixSlotId: string,
  participants: number
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
      const sessions = await fetchWixClassSessions(creds, activity.wix_service_id);
      const session = sessions.find((s) => s.id === slotKey.sessionId && s.remainingCapacity >= participants);
      if (!session) {
        return {
          ok: false,
          status: 409,
          error: participants > 1 ? 'Not enough spots left for that many children' : 'That class is no longer available',
        };
      }
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
      const available = await fetchWixAvailability(creds, activity.wix_service_id);
      const slot = available.find((s) => s.bookable && s.localStartDate === slotKey.s && s.localEndDate === slotKey.e);
      if (!slot) {
        return { ok: false, status: 409, error: 'That slot is no longer available' };
      }
      // startsAt/endsAt here end up in activity_sessions (ensureLocalWixSession)
      // and must be true UTC — slot.localStartDate/localEndDate themselves stay
      // untouched on `resolved.slot` since createWixBooking sends those exact
      // site-local strings back to Wix's own create-booking call.
      return {
        ok: true,
        key,
        startsAt: wixLocalToUtcIso(slot.localStartDate, slot.timeZone ?? 'UTC'),
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
  participants = 1
): Promise<
  | { ok: true; sessionId: string; wixBookingId: string }
  | { ok: false; status: number; error: string }
> {
  const resolved = await resolveWixSlot(creds, activity, wixSlotId, participants);
  if (!resolved.ok) return resolved;

  let wixBookingId: string;
  try {
    if (resolved.resolved.kind === 'class') {
      const booking = await createWixClassBooking(creds, resolved.resolved.session, contact, participants);
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
  participants = 1
): Promise<
  | { ok: true; sessionId: string }
  | { ok: false; status: number; error: string }
> {
  const resolved = await resolveWixSlot(creds, activity, wixSlotId, participants);
  if (!resolved.ok) return resolved;

  const sessionId = await ensureLocalWixSession(admin, activity.id, resolved.key, resolved.startsAt, resolved.endsAt, resolved.capacity);
  if (!sessionId) return { ok: false, status: 500, error: 'Could not prepare this session — contact support' };
  return { ok: true, sessionId };
}
