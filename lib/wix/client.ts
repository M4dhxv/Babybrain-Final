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
  description?: string;
  // Where the service is offered. Unlike WixLocation (from the separate
  // Locations query, which has a name), this nested shape only carries an
  // id/type/address — services-to-activities sync cross-references it
  // against fetchWixLocations() by id to get the name.
  locations?: { id: string; type: string; calculatedAddress?: { formattedAddress?: string; postalCode?: string } }[];
  payment?: {
    rateType?: string; // FIXED | CUSTOM | VARIED | NO_FEE | SUBSCRIPTION
    fixed?: { price?: { value?: string; currency?: string } };
    // Wix's own representative price for a per-variant rate (e.g. a camp
    // priced 99-459 depending on which week/add-ons) — not necessarily what
    // every booking costs, but the closest thing to a single number Wix has.
    varied?: { defaultPrice?: { value?: string; currency?: string } };
  };
  defaultCapacity?: number;
  // Wix's Media object — same mainMedia/coverMedia/items shape used across
  // its APIs (Stores, Bookings, ...). A service normally has at most a
  // handful of photos; only the cover shot is worth pulling in here.
  media?: {
    mainMedia?: { image?: { url?: string } };
    coverMedia?: { image?: { url?: string } };
    items?: { image?: { url?: string } }[];
  };
}

/** The service's price in the service's own currency, or:
 *  - `0` for a NO_FEE service (parent-facing pages render 0 as "Free")
 *  - Wix's own `defaultPrice` for a VARIED service (the real price still
 *    depends on which variant a customer picks — this is a representative
 *    starting point, same as what Wix's own dashboard shows as the
 *    service's price)
 *  - `null` when Wix has no number to give at all — CUSTOM (a free-text
 *    rate like "Contact us"), SUBSCRIPTION, or a missing/malformed
 *    `payment` block. Callers should leave whatever price is already on
 *    the activity alone in this case rather than clobbering a
 *    vendor-entered value with nothing. */
export function wixServicePrice(service: WixService): number | null {
  const rateType = service.payment?.rateType;
  if (rateType === 'NO_FEE') return 0;
  if (rateType === 'FIXED') {
    const value = Number(service.payment?.fixed?.price?.value);
    return Number.isFinite(value) ? value : null;
  }
  if (rateType === 'VARIED') {
    const value = Number(service.payment?.varied?.defaultPrice?.value);
    return Number.isFinite(value) ? value : null;
  }
  return null;
}

/** The service's default booking capacity, or `null` when Wix doesn't
 *  return one (an appointment service, or a class/course that's never had
 *  it set) — callers should leave whatever capacity is already on the
 *  activity alone in this case, same reasoning as {@link wixServicePrice}. */
export function wixServiceCapacity(service: WixService): number | null {
  const value = service.defaultCapacity;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/** Bookings' `image.url` isn't actually a URL — it's either the bare Wix
 *  Media filename (`d93c31_...~mv2.jpg`, as returned here) or, elsewhere in
 *  Wix's APIs, a `wix:image://v1/<that same filename>/...` URI. Either way
 *  the real, publicly-loadable photo lives at
 *  `static.wixstatic.com/media/<filename>` — already-absolute http(s) URLs
 *  are passed through untouched in case some account ever returns one. */
function resolveWixMediaUrl(raw: string): string {
  if (/^https?:\/\//i.test(raw)) return raw;
  const filename = raw.replace(/^wix:image:\/\/v1\//i, '').split('/')[0].split('#')[0];
  return `https://static.wixstatic.com/media/${filename}`;
}

/** The service's cover photo, or `null` when Wix has none — mainMedia first
 *  (the photo a vendor picked as the cover), falling back to coverMedia then
 *  the first gallery item, since not every account's response populates all
 *  three the same way. */
export function wixServiceImageUrl(service: WixService): string | null {
  const url =
    service.media?.mainMedia?.image?.url ??
    service.media?.coverMedia?.image?.url ??
    service.media?.items?.find((i) => i.image?.url)?.image?.url;
  const trimmed = url?.trim();
  return trimmed ? resolveWixMediaUrl(trimmed) : null;
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

export interface WixLocation {
  id: string;
  name: string;
  address: string | null;
  postalCode: string | null;
  isDefault: boolean;
}

/** The vendor's actual business address(es) on Wix — distinct from
 *  `WixTimeSlot.location`/`LOCATION_TYPE_MAP` below, which is where a given
 *  *slot* happens (business/custom/customer). Used by Settings -> Locations'
 *  "Fetch from Wix" so a vendor doesn't have to retype an address already on
 *  file with Wix. Only BUSINESS-type locations are returned — CUSTOM (a
 *  one-off address set by the business) and CUSTOMER (the client's own
 *  address, appointment services only) aren't a reusable "location" here. */
export async function fetchWixLocations(creds: WixCredentials): Promise<WixLocation[]> {
  interface RawLocation {
    id: string;
    type: string;
    business?: {
      id: string;
      name: string;
      default: boolean;
      address?: { formattedAddress?: string; postalCode?: string };
    };
  }
  const data = await wixFetch<{ businessLocations?: { locations?: RawLocation[] } }>(
    creds,
    '/bookings/v2/services/locations/query',
    { filter: {} }
  );
  return (data.businessLocations?.locations ?? [])
    .filter((l): l is RawLocation & { business: NonNullable<RawLocation['business']> } => l.type === 'BUSINESS' && !!l.business)
    .map((l) => ({
      id: l.business.id,
      name: l.business.name,
      address: l.business.address?.formattedAddress ?? null,
      postalCode: l.business.address?.postalCode ?? null,
      isDefault: l.business.default,
    }));
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
  revision?: string;
}

/** `flowControlSettings.skipBusinessConfirmation` on create does NOT confirm
 *  a booking — it only skips requiring the business's manual approval. Every
 *  booking still lands in status CREATED, which Wix's own docs say "doesn't
 *  yet appear in the business calendar." A separate Confirm Booking call
 *  (using the revision returned from create) is what actually flips it to
 *  CONFIRMED — the status that shows up in the Wix dashboard and decrements
 *  the session's remaining capacity. Confirmed empirically: without this
 *  call, bookings were created successfully in Wix (visible via the
 *  bookings/query API) but never appeared on the merchant's calendar. */
async function confirmWixBooking(creds: WixCredentials, booking: WixBooking): Promise<WixBooking> {
  const data = await wixFetch<{ booking?: WixBooking }>(
    creds,
    `/_api/bookings-service/v2/bookings/${booking.id}/confirm`,
    { revision: booking.revision }
  );
  return data.booking ?? booking;
}

export async function createWixBooking(
  creds: WixCredentials,
  slot: WixTimeSlot,
  resourceId: string,
  contact: WixContactDetails,
  totalParticipants = 1
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
      totalParticipants,
      contactDetails: contact,
    },
    flowControlSettings: { skipBusinessConfirmation: true },
  });
  if (!data.booking) throw new Error('Wix booking creation returned no booking');
  return confirmWixBooking(creds, data.booking);
}

/** Books one occurrence of a CLASS/COURSE. Uses `bookedEntity.slot` (keyed
 *  on the session's `eventId`), not `bookedEntity.schedule` — `schedule` is
 *  for enrolling in an entire COURSE's date range and was silently doing
 *  that here, booking the whole recurring series (e.g. Aug 19 – Aug 31)
 *  instead of the single occurrence the parent actually picked, which is
 *  the other reason these bookings never matched anything on the Wix
 *  calendar's day view. No resource — Wix's own BOOKING_POLICY_VIOLATION
 *  rejects a plain request even when the service's early/late-booking
 *  policies are disabled, so `ignoreBookingWindow` is required here
 *  (confirmed empirically against the sandbox site). */
export async function createWixClassBooking(
  creds: WixCredentials,
  session: WixClassSession,
  contact: WixContactDetails,
  totalParticipants = 1
): Promise<WixBooking> {
  const data = await wixFetch<{ booking?: WixBooking }>(creds, '/_api/bookings-service/v2/bookings', {
    booking: {
      bookedEntity: {
        slot: {
          eventId: session.eventId,
          scheduleId: session.scheduleId,
          serviceId: session.serviceId,
        },
      },
      totalParticipants,
      contactDetails: contact,
    },
    flowControlSettings: { skipBusinessConfirmation: true, ignoreBookingWindow: true },
  });
  if (!data.booking) throw new Error('Wix class booking creation returned no booking');
  return confirmWixBooking(creds, data.booking);
}

export interface WixConfirmedBooking {
  start: string; // ISO timestamp
  end: string; // ISO timestamp
}

/** Real confirmed bookings against one APPOINTMENT service — the
 *  unambiguous "a customer actually holds this exact time" signal, unlike
 *  `WixTimeSlot.bookable`. Wix returns `bookable: false` for a slot for any
 *  reason it won't offer that slot to a *new* customer right now — a real
 *  booking, but also e.g. the service's own minimum-notice booking policy
 *  blocking same-day slots, or the resource simply being off work. Treating
 *  `!bookable` as "booked" (as the naive capacity math does) shows a vendor
 *  their own booking-window policy as a phantom customer booking. Used by
 *  /api/wix/slots to derive the vendor Schedule page's booked/Full count
 *  instead. Doesn't affect what a parent can actually book — that path
 *  filters on `bookable` directly, same as before. */
export async function fetchWixConfirmedAppointmentBookings(creds: WixCredentials, serviceId: string): Promise<WixConfirmedBooking[]> {
  interface RawBooking {
    status: string;
    startDate?: string;
    endDate?: string;
  }
  const data = await wixFetch<{ bookings?: RawBooking[] }>(creds, '/bookings/v2/bookings/query', {
    query: {
      filter: { 'bookedEntity.slot.serviceId': serviceId },
      paging: { limit: 100 },
    },
  });
  return (data.bookings ?? [])
    .filter((b) => b.status === 'CONFIRMED' && b.startDate && b.endDate)
    .map((b) => ({ start: b.startDate!, end: b.endDate! }));
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

export interface WixEvent {
  id: string;
  title: string;
  slug: string;
  status: string; // UPCOMING | STARTED | ENDED | CANCELED | DRAFT
  startDate: string; // ISO timestamp
  endDate: string; // ISO timestamp
  timeZoneId?: string;
  location: {
    name: string | null;
    type: string | null; // VENUE | ONLINE
    city: string | null;
    formattedAddress: string | null;
    locationTbd: boolean;
  };
  mainImageUrl: string | null;
}

/** Wix Events & Tickets — a separate Wix app/API from Bookings (everything
 *  else in this file), with its own `SCOPE.DC-EVENTS.READ-EVENTS`
 *  permission on the API key and its own install requirement on the site.
 *  A vendor connected for Bookings only won't have either, so this throws
 *  the same {@link WixApiError} as everything else here on a 403/404 —
 *  callers that want to treat "no Events access" as empty rather than a
 *  hard failure should catch it themselves, same as {@link fetchWixLocations}
 *  is already handled at its call site in lib/wix/sync.ts.
 *
 * Status and the `days` date-range are both applied client-side, not via
 * the query's own `filter` — confirmed empirically against a real Events
 * site that Wix's date-range filter operators reject
 * `dateAndTimeSettings.startDate` ("invalid for field start of type
 * DateTime") despite that being the field name the API's own docs list as
 * filterable; sorting and unfiltered paging both work fine, so this fetches
 * the account's events (up to the 100-row page size) and narrows down
 * after the fact instead of fighting that filter's real syntax. Draft
 * events are excluded server-side (the query's `includeDrafts` defaults to
 * false); cancelled ones and anything outside `days` are excluded here. */
export async function fetchWixEvents(creds: WixCredentials, days = 90): Promise<WixEvent[]> {
  const now = new Date();
  const to = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  interface RawEvent {
    id: string;
    title: string;
    slug: string;
    status: string;
    dateAndTimeSettings?: { startDate?: string; endDate?: string; timeZoneId?: string };
    location?: {
      name?: string;
      type?: string;
      locationTbd?: boolean;
      address?: { city?: string; formattedAddress?: string };
    };
    mainImage?: { url?: string };
  }

  const data = await wixFetch<{ events?: RawEvent[] }>(creds, '/events/v3/events/query', {
    query: {
      paging: { limit: 100 },
      sort: [{ fieldName: 'dateAndTimeSettings.startDate', order: 'ASC' }],
    },
  });

  return (data.events ?? [])
    .filter((e) => e.status !== 'CANCELED')
    .filter((e) => {
      const start = e.dateAndTimeSettings?.startDate;
      const end = e.dateAndTimeSettings?.endDate;
      if (!start || !end) return false;
      const startMs = new Date(start).getTime();
      return startMs >= now.getTime() && startMs <= to.getTime();
    })
    .map((e) => ({
      id: e.id,
      title: e.title,
      slug: e.slug,
      status: e.status,
      startDate: e.dateAndTimeSettings!.startDate!,
      endDate: e.dateAndTimeSettings!.endDate!,
      timeZoneId: e.dateAndTimeSettings?.timeZoneId,
      location: {
        name: e.location?.name ?? null,
        type: e.location?.type ?? null,
        city: e.location?.address?.city ?? null,
        formattedAddress: e.location?.address?.formattedAddress ?? null,
        locationTbd: e.location?.locationTbd ?? false,
      },
      mainImageUrl: e.mainImage?.url ?? null,
    }));
}
