/**
 * Server-only Wix Bookings API client. Never import client-side — every call
 * carries a bearer token. Ported from scripts/wix_bookings_test.py's
 * Bookings v2 flow (services → resources → availability → create booking).
 *
 * Wix Bookings treats APPOINTMENT services and CLASS/COURSE services as two
 * separate systems with different endpoints and booking payloads:
 *   - APPOINTMENT: 1:1 slots via /_api/service-availability/v2/time-slots,
 *     booked against a specific staff resource.
 *   - CLASS/COURSE: group sessions with real capacity, via
 *     /bookings/v2/calendar/sessions/query, booked against a schedule +
 *     event id (no resource). The time-slots endpoint rejects these
 *     outright ("Only appointment services are supported").
 * `activities.wix_service_type` tells the API routes which path to use.
 *
 * Each business connects its own Wix account (Settings -> Integrate your
 * Business), stored in provider_wix_credentials — so every function here
 * takes a {@link WixCredentials} explicitly rather than reading a single
 * global env var. Use {@link getProviderWixCredentials} to resolve a
 * provider's stored credentials.
 */

const WIX_API_BASE = 'https://www.wixapis.com';

export interface WixCredentials {
  accessToken: string;
  siteId: string;
}

/** Thrown by {@link wixFetch} on a non-2xx response, carrying the raw HTTP
 *  status and body so callers (e.g. the connect-credentials route) can tell
 *  "wrong site ID" apart from "bad/revoked key" instead of one generic
 *  failure message. */
export class WixApiError extends Error {
  constructor(public status: number, public path: string, public body: string) {
    super(`Wix API ${path} failed (${status}): ${body}`);
    this.name = 'WixApiError';
  }
}

function wixHeaders(creds: WixCredentials): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${creds.accessToken}`,
    'wix-site-id': creds.siteId,
  };
}

async function wixFetch<T>(creds: WixCredentials, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${WIX_API_BASE}${path}`, {
    method: 'POST',
    headers: wixHeaders(creds),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new WixApiError(res.status, path, text);
  }
  return res.json() as Promise<T>;
}

/** Turn a WixApiError into a message a vendor can actually act on, instead
 *  of one generic "check the key and site ID" for every failure mode. */
export function describeWixApiError(e: unknown): string {
  if (!(e instanceof WixApiError)) {
    return 'Could not verify these credentials against Wix — check the key and site ID.';
  }
  if (e.status === 404 && /meta-site .* not found/i.test(e.body)) {
    return "This Site ID doesn't match the account this API key belongs to — " +
      'make sure both are copied from the same Wix site (if you manage more than one).';
  }
  if (e.status === 401 || e.status === 403) {
    return 'This API key was rejected by Wix — check it hasn\'t been revoked and has Bookings read/write permissions.';
  }
  return `Wix rejected these credentials (${e.status}) — check the key and site ID.`;
}

/** Safe-to-display form of an API key: mostly masked, last 10 characters
 *  visible — computed once at save time so the default status view never
 *  needs the real key. */
export function maskWixApiKey(key: string): string {
  const tail = key.slice(-10);
  const hidden = Math.max(key.length - tail.length, 4);
  return '•'.repeat(hidden) + tail;
}

/** A provider's stored Wix credentials, or null if they haven't connected
 *  one yet. Always go through the service-role admin client — this table
 *  has no RLS policies at all, so an RLS-scoped client always gets nothing. */
export async function getProviderWixCredentials(
  admin: { from: (table: string) => any },
  providerId: string
): Promise<WixCredentials | null> {
  const { data } = await admin
    .from('provider_wix_credentials')
    .select('wix_api_key, wix_site_id')
    .eq('provider_id', providerId)
    .maybeSingle();
  if (!data) return null;
  return { accessToken: data.wix_api_key, siteId: data.wix_site_id };
}

export interface WixService {
  id: string;
  name: string;
  type: string;
}

export interface WixResource {
  id: string;
  name: string;
  bookable: boolean;
}

export interface WixTimeSlot {
  scheduleId?: string;
  serviceId: string;
  localStartDate: string;
  localEndDate: string;
  bookable: boolean;
  location?: { locationType?: string };
}

export async function fetchWixServices(creds: WixCredentials): Promise<WixService[]> {
  const data = await wixFetch<{ services?: WixService[] }>(creds, '/bookings/v2/services/query', {
    query: { paging: { limit: 50 } },
  });
  return data.services ?? [];
}

export async function fetchWixResources(creds: WixCredentials): Promise<WixResource[]> {
  const data = await wixFetch<{ resources?: WixResource[] }>(creds, '/bookings/v2/resources/query', {
    query: {},
  });
  return data.resources ?? [];
}

/** Every time slot for an APPOINTMENT service over the next `days` days,
 *  bookable or not. Callers that only want to offer a slot for booking
 *  (the parent picker, the re-validation in app/api/wix/bookings) must
 *  filter on `.bookable` themselves — kept unfiltered here so the vendor
 *  calendar can also show already-booked/blocked slots. */
export async function fetchWixAvailability(creds: WixCredentials, serviceId: string, days = 7): Promise<WixTimeSlot[]> {
  const now = new Date();
  const to = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const localDate = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, '');

  const data = await wixFetch<{ timeSlots?: WixTimeSlot[] }>(creds, '/_api/service-availability/v2/time-slots', {
    serviceId,
    fromLocalDate: localDate(now),
    toLocalDate: localDate(to),
    timezone: 'UTC',
  });
  return data.timeSlots ?? [];
}

export interface WixClassSession {
  id: string;
  scheduleId: string;
  eventId: string;
  serviceId: string;
  start: string; // ISO timestamp
  end: string; // ISO timestamp
  capacity: number;
  remainingCapacity: number;
}

/** Every occurrence for a CLASS/COURSE service over the next `days` days,
 *  full or not — callers that only want bookable ones must filter on
 *  `.remainingCapacity > 0` themselves. Unlike appointments, availability
 *  here isn't scoped by serviceId server-side — the query returns sessions
 *  for every service, each carrying `scheduleOwnerId` (= the service id),
 *  so we filter client-side. */
export async function fetchWixClassSessions(creds: WixCredentials, serviceId: string, days = 7): Promise<WixClassSession[]> {
  const now = new Date();
  const to = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const iso = (d: Date) => d.toISOString();

  interface RawSession {
    id: string;
    scheduleId: string;
    scheduleOwnerId: string;
    eventId: string;
    status: string;
    capacity: number;
    remainingCapacity: number;
    start: { timestamp: string };
    end: { timestamp: string };
  }
  const data = await wixFetch<{ sessions?: RawSession[] }>(creds, '/bookings/v2/calendar/sessions/query', {
    query: { paging: { limit: 100 } },
    fromDate: iso(now),
    toDate: iso(to),
  });
  return (data.sessions ?? [])
    .filter((s) => s.scheduleOwnerId === serviceId && s.status === 'CONFIRMED')
    .map((s) => ({
      id: s.id,
      scheduleId: s.scheduleId,
      eventId: s.eventId,
      serviceId: s.scheduleOwnerId,
      start: s.start.timestamp,
      end: s.end.timestamp,
      capacity: s.capacity,
      remainingCapacity: s.remainingCapacity,
    }));
}

/** Stable id for a slot/session, used both as `activity_sessions.wix_slot_key`
 *  and (prefixed with "wix:") as the frontend's session id. Re-fetching
 *  availability and matching on this key is how a booking attempt is
 *  re-validated against Wix without trusting client-supplied slot data. */
export type WixSlotKey =
  | { kind: 'appointment'; s: string; e: string }
  | { kind: 'class'; sessionId: string };

export function encodeWixSlotKey(payload: WixSlotKey): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function decodeWixSlotKey(key: string): WixSlotKey {
  return JSON.parse(Buffer.from(key, 'base64url').toString('utf8'));
}

const LOCATION_TYPE_MAP: Record<string, string> = {
  BUSINESS: 'OWNER_BUSINESS',
  CUSTOM: 'OWNER_CUSTOM',
};

export interface WixContactDetails {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}

export interface WixBooking {
  id: string;
  status: string;
}

export async function createWixBooking(
  creds: WixCredentials,
  slot: WixTimeSlot,
  resourceId: string,
  contact: WixContactDetails
): Promise<WixBooking> {
  const rawLocationType = slot.location?.locationType ?? 'BUSINESS';
  const mappedLocationType = LOCATION_TYPE_MAP[rawLocationType] ?? rawLocationType;

  const data = await wixFetch<{ booking?: WixBooking }>(creds, '/_api/bookings-service/v2/bookings', {
    booking: {
      bookedEntity: {
        slot: {
          startDate: slot.localStartDate,
          endDate: slot.localEndDate,
          serviceId: slot.serviceId,
          scheduleId: slot.scheduleId,
          resource: { id: resourceId },
          location: { locationType: mappedLocationType },
        },
      },
      numberOfParticipants: 1,
      contactDetails: contact,
    },
    // Makes the booking CONFIRMED immediately, visible in the Wix dashboard,
    // rather than left pending on the business's manual approval.
    flowControlSettings: { skipBusinessConfirmation: true },
  });
  if (!data.booking) throw new Error('Wix booking creation returned no booking');
  return data.booking;
}

/** Books one occurrence of a CLASS/COURSE. No resource — Wix's own
 *  BOOKING_POLICY_VIOLATION rejects a plain request even when the service's
 *  early/late-booking policies are disabled, so `ignoreBookingWindow` is
 *  required here (confirmed empirically against the sandbox site). */
export async function createWixClassBooking(
  creds: WixCredentials,
  session: WixClassSession,
  contact: WixContactDetails
): Promise<WixBooking> {
  const data = await wixFetch<{ booking?: WixBooking }>(creds, '/_api/bookings-service/v2/bookings', {
    booking: {
      bookedEntity: {
        schedule: { scheduleId: session.scheduleId, eventId: session.eventId },
      },
      numberOfParticipants: 1,
      contactDetails: contact,
    },
    flowControlSettings: { skipBusinessConfirmation: true, ignoreBookingWindow: true },
  });
  if (!data.booking) throw new Error('Wix class booking creation returned no booking');
  return data.booking;
}

export interface WixBusyRange {
  start: string; // ISO timestamp
  end: string; // ISO timestamp
}

/** Every time range the vendor is already committed to somewhere in their
 *  Wix account, across all services — used to block a vendor from adding an
 *  independent (non-Wix) BabyBrain slot that clashes with something on Wix.
 *  Two sources, since Wix tracks them separately:
 *    - confirmed bookings (1:1 appointments or class bookings)
 *    - scheduled class/course sessions (a commitment even with 0 attendees)
 */
export async function fetchWixBusyRanges(creds: WixCredentials, days = 14): Promise<WixBusyRange[]> {
  const now = new Date();
  const to = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const iso = (d: Date) => d.toISOString();

  interface RawBooking {
    status: string;
    startDate?: string;
    endDate?: string;
  }
  interface RawSession {
    status: string;
    start: { timestamp: string };
    end: { timestamp: string };
  }

  const [bookingsData, sessionsData] = await Promise.all([
    wixFetch<{ bookings?: RawBooking[] }>(creds, '/bookings/v2/bookings/query', {
      query: {
        filter: { startDate: { $gte: iso(now) }, endDate: { $lte: iso(to) } },
        paging: { limit: 100 },
      },
    }),
    wixFetch<{ sessions?: RawSession[] }>(creds, '/bookings/v2/calendar/sessions/query', {
      query: { paging: { limit: 100 } },
      fromDate: iso(now),
      toDate: iso(to),
    }),
  ]);

  const bookingRanges = (bookingsData.bookings ?? [])
    .filter((b) => b.status !== 'CANCELLED' && b.startDate && b.endDate)
    .map((b) => ({ start: b.startDate!, end: b.endDate! }));

  const sessionRanges = (sessionsData.sessions ?? [])
    .filter((s) => s.status === 'CONFIRMED')
    .map((s) => ({ start: s.start.timestamp, end: s.end.timestamp }));

  return [...bookingRanges, ...sessionRanges];
}
