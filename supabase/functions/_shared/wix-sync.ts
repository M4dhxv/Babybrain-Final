import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import {
  fetchWixServices,
  fetchWixResources,
  fetchWixLocations,
  fetchWixAvailability,
  fetchWixClassSessions,
  fetchWixCourseSpan,
  fetchWixConfirmedAppointmentBookings,
  encodeWixSlotKey,
  wixServicePrice,
  wixServiceCapacity,
  wixServiceImageUrl,
  wixLocalToUtcIso,
  wixSlotStaff,
  formatWixStaffNames,
  selectNonOverlappingSlots,
  type WixCredentials,
  type WixService,
  type WixLocation,
  type WixTimeSlot,
  type WixClassSession,
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

/** See lib/wix/sync.ts's importWixSessionStaff — identical logic. */
async function importWixSessionStaff(
  admin: SupabaseClient,
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
    if (!name || row.teacher_name === name) continue;
    const ids = idsByName.get(name);
    if (ids) ids.push(row.id);
    else idsByName.set(name, [row.id]);
  }
  if (idsByName.size === 0) return 0;

  let updated = 0;
  for (const [name, ids] of idsByName) {
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

/** See lib/wix/sync.ts's reconcileStaleWixSessions (moved there from
 *  app/api/wix/slots/route.ts) — identical logic. */
async function reconcileStaleWixSessions(
  admin: SupabaseClient,
  activityId: string,
  currentKeys: Set<string>,
  windowStart: Date,
  windowEnd: Date
): Promise<void> {
  const { data: existing } = await admin
    .from('activity_sessions')
    .select('id, wix_slot_key, wix_remaining_capacity, capacity')
    .eq('activity_id', activityId)
    .not('wix_slot_key', 'is', null)
    .not('wix_slot_key', 'like', 'wixcourse:%')
    .gte('starts_at', windowStart.toISOString())
    .lt('starts_at', windowEnd.toISOString());
  const stale = (existing ?? []).filter((s: any) => !currentKeys.has(s.wix_slot_key));
  if (stale.length === 0) return;

  const { data: bookings } = await admin
    .from('bookings')
    .select('session_id, status')
    .in('session_id', stale.map((s: any) => s.id));
  const bookedSessionIds = new Set(
    (bookings ?? []).filter((b: any) => b.status !== 'cancelled').map((b: any) => b.session_id)
  );

  for (const s of stale) {
    const bookedOnWix = s.wix_remaining_capacity != null && s.capacity != null && s.wix_remaining_capacity < s.capacity;
    if (bookedSessionIds.has(s.id) || bookedOnWix) continue;
    await admin.from('activity_sessions').delete().eq('id', s.id);
  }
}

interface WixSlotActivity {
  id: string;
  wix_service_id: string;
  wix_resource_id: string | null;
  wix_service_type: string | null;
}

type WixAvailabilitySyncResult =
  | { kind: 'class'; sessions: WixClassSession[]; courseSpan: { start: string; end: string } | null }
  | { kind: 'appointment'; slots: WixTimeSlot[] };

/** See lib/wix/sync.ts's syncWixActivityAvailability — identical logic
 *  (this *is* that function's port, the same way everything else in this
 *  file is; app/api/wix/slots/route.ts calls the Vercel original, this cron
 *  is the other caller). Fetches one activity's live Wix availability and
 *  upserts it into activity_sessions — branching on APPOINTMENT (time-slots
 *  API) vs CLASS/COURSE (calendar/sessions API). Throws on a genuine Wix/DB
 *  failure; the caller below (syncWixServicesToActivities) runs this across
 *  many activities via allSettled so one account's Wix hiccup can't sink
 *  the rest. */
async function syncWixActivityAvailability(
  admin: SupabaseClient,
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
  const staffIdsPromise: Promise<Set<string> | null> = fetchWixResources(creds)
    .then((rs) => new Set(rs.filter((r) => r.bookable).map((r) => r.id)))
    .catch(() => null);

  if (isClass) {
    const [sessions, knownStaffIds] = await Promise.all([
      fetchWixClassSessions(creds, activity.wix_service_id, days),
      staffIdsPromise,
    ]);
    const staffBySlotKey = new Map(
      sessions.map((s) => [
        encodeWixSlotKey({ kind: 'class', sessionId: s.id }),
        formatWixStaffNames(s.staff, knownStaffIds ?? undefined),
      ])
    );

    let courseSpan: { start: string; end: string } | null = null;
    if (activity.wix_service_type === 'COURSE') {
      try {
        const span = await fetchWixCourseSpan(creds, activity.wix_service_id);
        if (span.start && span.end) courseSpan = { start: span.start, end: span.end };
      } catch (e) {
        console.error('Wix course span lookup failed', e);
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
        })),
        { onConflict: 'activity_id,wix_slot_key' }
      );
      if (syncError) console.error('Wix class session sync failed', syncError);
      await importWixSessionStaff(admin, activity.id, staffBySlotKey);
    }
    await reconcileStaleWixSessions(
      admin,
      activity.id,
      new Set(sessions.map((s) => encodeWixSlotKey({ kind: 'class', sessionId: s.id }))),
      windowStart,
      windowEnd
    );
    return { kind: 'class', sessions, courseSpan };
  }

  const [rawSlots, confirmedBookings, knownStaffIds] = await Promise.all([
    fetchWixAvailability(creds, activity.wix_service_id, days, [activity.wix_resource_id]),
    fetchWixConfirmedAppointmentBookings(creds, activity.wix_service_id).catch(() => []),
    staffIdsPromise,
  ]);
  const slots = selectNonOverlappingSlots(rawSlots);
  const bookedStarts = new Set(confirmedBookings.map((b) => new Date(b.start).toISOString()));
  const staffBySlotKey = new Map(
    slots.map((s) => [
      encodeWixSlotKey({ kind: 'appointment', s: s.localStartDate, e: s.localEndDate }),
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
          wix_slot_key: encodeWixSlotKey({ kind: 'appointment', s: s.localStartDate, e: s.localEndDate }),
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
    new Set(slots.map((s) => encodeWixSlotKey({ kind: 'appointment', s: s.localStartDate, e: s.localEndDate }))),
    windowStart,
    windowEnd
  );
  return { kind: 'appointment', slots };
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
  // Every APPOINTMENT/CLASS/COURSE this run touches — see the availability
  // pass after the loop below for why this exists (lib/wix/sync.ts's own
  // copy of the same comment has the full story).
  const activitiesForAvailabilitySync: WixSlotActivity[] = [];

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
    const description =
      wixDescription ||
      'Imported from Wix. Finish this listing — category, age range and description — then publish it when ready.';
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
  // pulled and materialized into activity_sessions right here — see
  // lib/wix/sync.ts's identical addition for the full reasoning: this used
  // to be the one thing this cron never did, so a Wix-linked activity's
  // actual date/time/duration stayed blank until some parent happened to
  // open its detail page. Concurrent across activities (allSettled) since
  // each is an independent Wix fetch with no shared state.
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
