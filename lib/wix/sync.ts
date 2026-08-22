import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import {
  fetchWixServices,
  fetchWixResources,
  fetchWixAvailability,
  fetchWixClassSessions,
  createWixBooking,
  createWixClassBooking,
  decodeWixSlotKey,
  type WixCredentials,
} from './client';

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

/**
 * Shared middle of every "book a Wix slot" flow, whichever way it's being
 * paid for: re-validates the slot against live Wix availability (never
 * trusts client-supplied slot times) to close the race where a slot fills
 * between the picker loading and "Book" being clicked, creates the real
 * booking in Wix, then materializes exactly one activity_sessions row for
 * it (find-or-create, keyed on wix_slot_key — a second parent booking the
 * same class occurrence must not reset capacity back to "before their
 * booking" on top of the first parent's already-counted seat).
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

  let startsAt: string;
  let endsAt: string;
  let capacity: number;
  let wixBookingId: string;

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
      const booking = await createWixClassBooking(creds, session, contact, participants);
      startsAt = session.start;
      endsAt = session.end;
      // The session's actual total capacity, not what's currently remaining
      // — activity_sessions.capacity is meant to be the fixed seat count the
      // local waitlist trigger compares bookings against.
      capacity = session.capacity;
      wixBookingId = booking.id;
    } else {
      const available = await fetchWixAvailability(creds, activity.wix_service_id);
      const slot = available.find((s) => s.bookable && s.localStartDate === slotKey.s && s.localEndDate === slotKey.e);
      if (!slot) {
        return { ok: false, status: 409, error: 'That slot is no longer available' };
      }
      const booking = await createWixBooking(creds, slot, activity.wix_resource_id!, contact, participants);
      startsAt = slot.localStartDate;
      endsAt = slot.localEndDate;
      capacity = 1;
      wixBookingId = booking.id;
    }
  } catch (e) {
    console.error('Wix booking creation failed', e);
    return { ok: false, status: 502, error: 'Could not create the booking in Wix' };
  }

  const { data: existingSession } = await admin
    .from('activity_sessions')
    .select('id')
    .eq('activity_id', activity.id)
    .eq('wix_slot_key', key)
    .maybeSingle();
  if (existingSession) {
    return { ok: true, sessionId: existingSession.id, wixBookingId };
  }

  const { data: newSession, error: sessionError } = await admin
    .from('activity_sessions')
    .insert({
      activity_id: activity.id,
      starts_at: startsAt,
      ends_at: endsAt,
      capacity,
      wix_slot_key: key,
    })
    .select('id')
    .single();
  if (sessionError || !newSession) {
    console.error('Booked in Wix but failed to materialize the local session', wixBookingId, sessionError);
    return { ok: false, status: 500, error: 'Booked in Wix but failed to save locally — contact support' };
  }
  return { ok: true, sessionId: newSession.id, wixBookingId };
}
