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

/** The app's ceiling for how far ahead Wix availability is ever looked up.
 *  Book-time re-validation must search at least as far as the widest window
 *  any picker can display, or a slot a parent can see becomes one they can't
 *  book: /api/wix/slots deliberately forces a 60-day window for COURSE
 *  services (a holiday camp's single occurrence routinely sits 40-50 days
 *  out), so re-validating over the old 7-day default found nothing and
 *  rejected every such booking with "no longer available". */
export const WIX_AVAILABILITY_WINDOW_DAYS = 60;

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
  // The staff/resource ids actually assigned to *this* service. An
  // APPOINTMENT booking must name a resource that's on the service — booking
  // one that merely exists on the account (Wix has other bookable staff)
  // fails with SLOT_NOT_AVAILABLE, so sync must not just grab the first
  // bookable resource it finds. See the resource pick in syncWixServicesToActivities.
  staffMemberIds?: string[];
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
  // `id` is the business location's own id and is NOT optional in practice
  // for booking: a site with more than one business location rejects every
  // create-booking call that sends a bare `locationType` with
  // SLOT_NOT_AVAILABLE, because Wix can't tell which location's slot is
  // meant. See createWixBooking.
  location?: { id?: string; name?: string; formattedAddress?: string; locationType?: string };
  // Which staff/resources are free for this exact slot. Only populated when
  // the request passes `resourceIds` (see fetchWixAvailability) — Wix leaves
  // it empty otherwise, even when a resource is in fact available. This is
  // the authoritative "who can I book this against", far better than a
  // service-level guess, because it accounts for that resource's own
  // calendar at this specific time.
  availableResources?: { resourceTypeId?: string; resources?: { id: string; name?: string }[] }[];
  // The IANA zone localStartDate/localEndDate are wall-clock time IN — see
  // the comment on fetchWixAvailability. Kept alongside the raw values
  // (rather than converting them in place) because those raw strings are
  // also the exact payload Wix's own create-booking call expects back
  // verbatim; only a caller that needs a true UTC instant (to store or
  // display) should touch this.
  timeZone?: string;
}

/** Turns a naive "wall-clock in some IANA zone" string (no offset — e.g. Wix's
 *  `localStartDate`) into the true UTC instant it represents, via the
 *  standard round-trip-through-Intl trick (no date library needed): read the
 *  string's digits as if they were already UTC, ask Intl what that instant
 *  reads as printed in `timeZone`, and the gap between the two is the zone's
 *  offset at that moment (DST-safe) — subtract it to land on the real UTC
 *  instant. `timeZone` is normally the response's own `timeZone` field, so
 *  this works for whatever zone a given Wix site is actually configured
 *  with, not just Singapore. */
export function wixLocalToUtcIso(naiveLocal: string, timeZone: string): string {
  if (timeZone === 'UTC') return `${naiveLocal}Z`;
  const assumedUtc = new Date(`${naiveLocal}Z`);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(assumedUtc).map((p) => [p.type, p.value])
  );
  // Midnight prints as "24" in this locale/format — Date.UTC expects 0.
  const hour = parts.hour === '24' ? 0 : Number(parts.hour);
  const readAsUtc = Date.UTC(+parts.year, Number(parts.month) - 1, +parts.day, hour, +parts.minute, +parts.second);
  const offsetMs = readAsUtc - assumedUtc.getTime();
  return new Date(assumedUtc.getTime() - offsetMs).toISOString();
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
 *  calendar can also show already-booked/blocked slots.
 *
 *  `localStartDate`/`localEndDate` are naive wall-clock strings with no UTC
 *  offset — confirmed empirically that they're in the *site's own configured
 *  business timezone* (the response's own `timeZone` field, e.g.
 *  "Asia/Kolkata" for a vendor who set their Wix site up from India),
 *  regardless of the `timezone` request param below: passing `'UTC'` there
 *  does not make Wix return UTC-normalized values — a real Wix site
 *  returned "11:00:00" for an 11:00 AM Kolkata slot either way. Sent anyway
 *  in case some accounts do honor it; every caller must treat the response's
 *  `timeZone` field, not this param, as ground truth (see
 *  {@link wixLocalToUtcIso}). Only correct for storage/display when
 *  converted through that — the raw strings are still exactly what Wix's
 *  own create-booking call expects back, so they're deliberately left
 *  untouched here rather than pre-converted. */
export async function fetchWixAvailability(
  creds: WixCredentials,
  serviceId: string,
  days = 7,
  resourceIds?: (string | null | undefined)[]
): Promise<WixTimeSlot[]> {
  const now = new Date();
  const to = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const localDate = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, '');
  const ids = (resourceIds ?? []).filter((id): id is string => !!id);

  const data = await wixFetch<{ timeSlots?: WixTimeSlot[]; timeZone?: string }>(creds, '/_api/service-availability/v2/time-slots', {
    serviceId,
    fromLocalDate: localDate(now),
    toLocalDate: localDate(to),
    timezone: 'UTC',
    // Without this, every slot comes back with `availableResources: []` —
    // not because no resource is free, but because Wix only resolves them
    // when asked. Passing the resource we intend to book against turns each
    // slot's `availableResources` into a real per-slot answer for that
    // staff member, which is what makes {@link wixSlotResourceId} reliable.
    ...(ids.length > 0 ? { resourceIds: ids } : {}),
  });
  const timeZone = data.timeZone ?? 'UTC';
  return (data.timeSlots ?? []).map((s) => ({ ...s, timeZone }));
}

/** The staff/resource Wix itself says is free for this exact slot, preferred
 *  over any service-level default — see WixTimeSlot.availableResources.
 *  Null when the caller didn't request resources (or none is free), in which
 *  case the caller should fall back to the activity's stored resource id. */
export function wixSlotResourceId(slot: WixTimeSlot): string | null {
  for (const group of slot.availableResources ?? []) {
    const first = group.resources?.[0]?.id;
    if (first) return first;
  }
  return null;
}

/**
 * Collapses Wix's rolling appointment grid into complete, non-overlapping
 * slots.
 *
 * Wix generates APPOINTMENT time slots on the site's *split interval*, not on
 * the service's duration — a 45-minute service on a 30-minute split returns
 * 10:00-10:45, 10:30-11:15, 11:00-11:45, ... Each is individually bookable,
 * but they're alternative start times for the same staff member, not separate
 * appointments: on a real day with 11 openings the API returns 84 slots for
 * the week, ~90% of which overlap a neighbour.
 *
 * Showing that raw list is what breaks booking. A parent picks 10:30, someone
 * else takes 10:00, and Wix doesn't merely mark 10:30 unbookable — it drops
 * every conflicting slot from the response and re-anchors the rest of the day
 * off the end of the new booking (10:45, 11:15, ...). The picked slot's key
 * no longer exists in availability at all, so re-validation at booking time
 * fails with "that slot is no longer available" for a slot the parent was
 * looking at seconds earlier. The vendor's Schedule calendar has the mirror
 * problem: 84 overlapping activity_sessions rows for a day that holds 11
 * appointments.
 *
 * The fix is to offer one canonical grid instead of every possible start
 * time: walk the day in chronological order and keep a slot only when it
 * starts at or after the end of the last one kept. `bookable` is deliberately
 * NOT considered here — the grid has to be the same set for the vendor
 * calendar (which shows booked and blocked slots too) as for the parent
 * picker (which filters this result down to bookable). Anchoring on only the
 * bookable ones would give the two views different, disagreeing grids.
 *
 * Slots are grouped per (day, location) before selection so an unrelated
 * second location can't shift the grid for the first.
 */
export function selectNonOverlappingSlots(slots: WixTimeSlot[]): WixTimeSlot[] {
  const groups = new Map<string, WixTimeSlot[]>();
  for (const slot of slots) {
    const key = `${slot.location?.id ?? ''}|${slot.localStartDate.slice(0, 10)}`;
    const group = groups.get(key);
    if (group) group.push(slot);
    else groups.set(key, [slot]);
  }

  const kept: WixTimeSlot[] = [];
  for (const group of groups.values()) {
    // Earliest start first, and among equal starts the shortest slot — a
    // service with several durations offers 10:00-10:30 and 10:00-11:00 for
    // the same opening, and taking the shorter leaves room for more.
    group.sort(
      (a, b) => a.localStartDate.localeCompare(b.localStartDate) || a.localEndDate.localeCompare(b.localEndDate)
    );
    let lastEnd = '';
    for (const slot of group) {
      if (slot.localStartDate < lastEnd) continue;
      kept.push(slot);
      lastEnd = slot.localEndDate;
    }
  }
  return kept.sort((a, b) => a.localStartDate.localeCompare(b.localStartDate));
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

/**
 * Books one APPOINTMENT slot.
 *
 * Three details here are each individually sufficient to make Wix reject the
 * call with a 428 SLOT_NOT_AVAILABLE — a response that says nothing about
 * which of them is wrong, so all three are load-bearing:
 *
 *  1. `location.id`. Sending only `locationType` works on a site with a
 *     single business location and fails on every site with two or more,
 *     because Wix can't tell which location's slot is meant and concludes
 *     there is no matching slot. The id comes from the slot itself, so it is
 *     always the location Wix offered that opening at.
 *  2. The resource must be one assigned to *this service* and free at *this
 *     time* — not merely a bookable resource somewhere on the account.
 *     `slot.availableResources` is Wix's own answer to that and wins over
 *     the caller's stored `resourceId` fallback.
 *  3. `startDate`/`endDate` stay the raw, offset-less `localStartDate`/
 *     `localEndDate` strings exactly as Wix returned them. Converting them
 *     to a real UTC instant, or attaching the site's own zone offset, both
 *     fail — Wix matches these against its grid as literal site-local
 *     wall-clock text. See fetchWixAvailability.
 */
export async function createWixBooking(
  creds: WixCredentials,
  slot: WixTimeSlot,
  resourceId: string,
  contact: WixContactDetails,
  totalParticipants = 1
): Promise<WixBooking> {
  const rawLocationType = slot.location?.locationType ?? 'BUSINESS';
  const mappedLocationType = LOCATION_TYPE_MAP[rawLocationType] ?? rawLocationType;
  const locationId = slot.location?.id;

  const data = await wixFetch<{ booking?: WixBooking }>(creds, '/_api/bookings-service/v2/bookings', {
    booking: {
      bookedEntity: {
        slot: {
          startDate: slot.localStartDate,
          endDate: slot.localEndDate,
          serviceId: slot.serviceId,
          scheduleId: slot.scheduleId,
          resource: { id: wixSlotResourceId(slot) ?? resourceId },
          location: {
            ...(locationId ? { id: locationId } : {}),
            locationType: mappedLocationType,
          },
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

/**
 * Books a CLASS occurrence or enrols in a COURSE. The two are NOT the same
 * call, and sending the wrong one is a hard 400 from Wix rather than a
 * silent mismatch:
 *
 *  - CLASS uses `bookedEntity.slot`, keyed on the occurrence's `eventId`, so
 *    a parent books exactly the one session they picked. (Using `schedule`
 *    here books the entire recurring series instead — e.g. every Tuesday for
 *    a month — which is why bookings once failed to line up with anything on
 *    the vendor's calendar day view.)
 *  - COURSE uses `bookedEntity.schedule`. A course is sold as a whole
 *    programme, not per-session, and Wix rejects the slot form outright with
 *    "Slot bookings are not allowed for course services". Its calendar
 *    query returns a course as a single entry spanning the full run
 *    (e.g. Oct 11 -> Oct 16), so enrolling in the schedule is also what the
 *    parent actually picked.
 *
 * `ignoreBookingWindow` is required for both: Wix returns
 * BOOKING_POLICY_VIOLATION on a plain request even when the service's
 * early/late-booking policies are disabled (confirmed empirically).
 */
export async function createWixClassBooking(
  creds: WixCredentials,
  session: WixClassSession,
  contact: WixContactDetails,
  totalParticipants = 1,
  isCourse = false
): Promise<WixBooking> {
  const bookedEntity = isCourse
    ? { schedule: { scheduleId: session.scheduleId }, serviceId: session.serviceId }
    : { slot: { eventId: session.eventId, scheduleId: session.scheduleId, serviceId: session.serviceId } };

  const data = await wixFetch<{ booking?: WixBooking }>(creds, '/_api/bookings-service/v2/bookings', {
    booking: {
      bookedEntity,
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
    postalCode: string | null;
    formattedAddress: string | null;
    locationTbd: boolean;
  };
  mainImageUrl: string | null;
  description: string;
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
      address?: { city?: string; postalCode?: string; formattedAddress?: string };
    };
    mainImage?: { url?: string };
    shortDescription?: string;
    detailedDescription?: string;
  }

  const START_FIELD = 'dateAndTimeSettings.startDate';
  const PAGE_SIZE = 100;
  // 10 pages of headroom. A vendor with more than 1000 events inside the
  // window is well past anything this picker can usefully display, and an
  // unbounded loop against a paging bug is worse than a truncated list.
  const MAX_EVENTS = PAGE_SIZE * 10;

  const raw: RawEvent[] = [];
  for (let offset = 0; offset < MAX_EVENTS; offset += PAGE_SIZE) {
    const data = await wixFetch<{ events?: RawEvent[] }>(creds, '/events/v3/events/query', {
      query: {
        // The date window is applied server-side, not after the fact. Wix
        // sorts by start date ascending, so filtering a single page in our
        // own code meant a vendor with 100+ *past* events had their upcoming
        // ones pushed off that page entirely and detected as zero events —
        // a fresh integration would show an empty picker for an account that
        // clearly has published events.
        //
        // Both bounds cannot live in one object: Wix's filter parser rejects
        // `{ $gte, $lte }` on a DateTime field ("invalid for field start of
        // type DateTime") and needs them as separate $and clauses.
        filter: {
          $and: [
            { [START_FIELD]: { $gte: now.toISOString() } },
            { [START_FIELD]: { $lte: to.toISOString() } },
          ],
        },
        sort: [{ fieldName: START_FIELD, order: 'ASC' }],
        paging: { limit: PAGE_SIZE, offset },
      },
    });
    const page = data.events ?? [];
    raw.push(...page);
    // A short page is the last page.
    if (page.length < PAGE_SIZE) break;
  }

  return raw
    .filter((e) => e.status !== 'CANCELED')
    // The window is already enforced above; this only guards the non-null
    // assertions below against an event with no schedule set at all.
    .filter((e) => !!e.dateAndTimeSettings?.startDate && !!e.dateAndTimeSettings?.endDate)
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
        postalCode: e.location?.address?.postalCode ?? null,
        formattedAddress: e.location?.address?.formattedAddress ?? null,
        locationTbd: e.location?.locationTbd ?? false,
      },
      mainImageUrl: e.mainImage?.url ?? null,
      description: e.detailedDescription?.trim() || e.shortDescription?.trim() || '',
    }));
}

export interface WixTicketDefinition {
  id: string;
  eventId: string;
  name: string;
  free: boolean;
  /** Decimal string (e.g. "100.00"), null for free/guest-price tickets. */
  priceValue: string | null;
  /** ISO 4217 code as set on the *event's own* Wix site — not assumed to
   *  match the platform's default currency. Confirmed live: a vendor's
   *  event can be priced in a different currency than everything else. */
  currency: string | null;
  limitPerCheckout: number | null;
  hidden: boolean;
  saleStatus: string; // SALE_SCHEDULED | SALE_STARTED | SALE_ENDED
  saleStartDate: string | null;
  saleEndDate: string | null;
  /** null = unlimited total tickets for this definition. */
  initialLimit: number | null;
  /** null = unlimited. */
  unsoldCount: number | null;
  soldOut: boolean;
  /** FEE_ADDED_AT_CHECKOUT means the real charge is higher than `priceValue`
   *  alone — see computeWixCheckoutTotal. The definition never carries the
   *  actual fee *rate*, only this type; the rate is only known once a real
   *  reservation is made. */
  feeType: string | null;
}

/** Ticket Definitions V3 — confirmed live that *querying* (not just writing)
 *  requires `SCOPE.DC-EVENTS.MANAGE-TICKET-DEF` on the API key; there is no
 *  separate read-only scope for ticket prices the way there is for events
 *  themselves (`READ-EVENTS`). `fields: ['SALES_DETAILS']` is required to
 *  get `unsoldCount`/`soldOut` at all — omitted, Wix leaves them out of the
 *  response entirely rather than returning nulls. */
export async function fetchWixTicketDefinitions(
  creds: WixCredentials,
  eventId: string
): Promise<WixTicketDefinition[]> {
  interface RawTicketDefinition {
    id: string;
    eventId: string;
    name: string;
    hidden?: boolean;
    limitPerCheckout?: number;
    initialLimit?: number;
    pricingMethod?: { fixedPrice?: { value: string; currency: string }; free?: boolean };
    salePeriod?: { startDate?: string; endDate?: string };
    saleStatus?: string;
    salesDetails?: { unsoldCount?: number | null; soldOut?: boolean };
    feeType?: string;
  }
  const data = await wixFetch<{ ticketDefinitions?: RawTicketDefinition[] }>(
    creds,
    '/events/v3/ticket-definitions/query',
    {
      query: { filter: { eventId }, paging: { limit: 100 } },
      fields: ['SALES_DETAILS'],
    }
  );
  return (data.ticketDefinitions ?? []).map((t) => ({
    id: t.id,
    eventId: t.eventId,
    name: t.name,
    free: t.pricingMethod?.free ?? false,
    priceValue: t.pricingMethod?.fixedPrice?.value ?? null,
    currency: t.pricingMethod?.fixedPrice?.currency ?? null,
    limitPerCheckout: t.limitPerCheckout ?? null,
    hidden: t.hidden ?? false,
    saleStatus: t.saleStatus ?? 'SALE_SCHEDULED',
    saleStartDate: t.salePeriod?.startDate ?? null,
    saleEndDate: t.salePeriod?.endDate ?? null,
    initialLimit: t.initialLimit ?? null,
    unsoldCount: t.salesDetails?.unsoldCount ?? null,
    soldOut: t.salesDetails?.soldOut ?? false,
    feeType: t.feeType ?? null,
  }));
}

export interface WixTicketReservationLine {
  ticketDefinitionId: string;
  quantity: number;
  price: { value: string; currency: string };
  subTotal: { value: string; currency: string };
  /** Present only when the ticket type adds its fee at checkout rather than
   *  absorbing it into the price — see {@link computeWixCheckoutTotal}. */
  serviceFee: { type: string; rate: string } | null;
}

export interface WixTicketReservation {
  id: string;
  status: string; // PENDING | CONFIRMED | CANCELED | CANCELED_MANUALLY | EXPIRED
  expirationDate: string | null;
  lines: WixTicketReservationLine[];
}

/** Reserves tickets for up to ~20-30 minutes (event-configured — confirmed
 *  live as 20 on a real event; there is no fixed platform-wide constant).
 *  Reservation, not payment: the hold is released automatically if never
 *  checked out. See app/api/wix/events/checkout for why the real Stripe
 *  charge amount is computed from this response's line items rather than
 *  from the ticket definition's price alone. */
export async function createWixTicketReservation(
  creds: WixCredentials,
  ticketDefinitionId: string,
  quantity: number
): Promise<WixTicketReservation> {
  interface RawLine {
    ticketDefinitionId: string;
    quantity: number;
    price: { value: string; currency: string };
    subTotal: { value: string; currency: string };
    serviceFee?: { type: string; rate: string };
  }
  const data = await wixFetch<{
    ticketReservation: { id: string; status: string; expirationDate?: string; tickets?: RawLine[] };
  }>(creds, '/events/v1/ticket-reservations', {
    ticketReservation: { tickets: [{ ticketDefinitionId, quantity }] },
  });
  const r = data.ticketReservation;
  return {
    id: r.id,
    status: r.status,
    expirationDate: r.expirationDate ?? null,
    lines: (r.tickets ?? []).map((t) => ({
      ticketDefinitionId: t.ticketDefinitionId,
      quantity: t.quantity,
      price: t.price,
      subTotal: t.subTotal,
      serviceFee: t.serviceFee ?? null,
    })),
  };
}

/** Sums a reservation's line items into the true amount to charge — Wix
 *  adds a service fee ON TOP of ticket price at checkout for
 *  FEE_ADDED_AT_CHECKOUT ticket types (confirmed live: a 100.00 ticket
 *  became a 102.50 order total at a 2.5% rate). FEE_INCLUDED/NO_FEE types
 *  charge exactly subTotal. Charging anything other than this exact number
 *  via Stripe would under- or over-collect relative to what Wix's own
 *  Confirm Order later records. Assumes a single currency across all lines
 *  (true for our one-ticket-type-per-checkout flow). */
export function computeWixCheckoutTotal(lines: WixTicketReservationLine[]): { value: number; currency: string } {
  let totalCents = 0;
  let currency = 'SGD';
  for (const line of lines) {
    currency = line.subTotal.currency;
    const subTotalCents = Math.round(Number(line.subTotal.value) * 100);
    totalCents +=
      line.serviceFee?.type === 'FEE_ADDED_AT_CHECKOUT'
        ? addTicketFeeCents(subTotalCents, Number(line.serviceFee.rate))
        : subTotalCents;
  }
  return { value: totalCents / 100, currency };
}

/** Discovers the actual fee rate a FEE_ADDED_AT_CHECKOUT ticket type carries
 *  by making a throwaway quantity-1 reservation and reading its
 *  serviceFee.rate — the only place Wix ever exposes the number (see
 *  {@link WixTicketDefinition.feeType}). The hold releases itself in
 *  20-30 min since it's never checked out; lib/wix/events-sync.ts calls
 *  this only once per ticket type (caching the result) rather than on every
 *  sync, so this doesn't tie up inventory repeatedly. Returns null if the
 *  type turns out not to carry a fee after all (e.g. sold out, or Wix's
 *  fee config changed since the definition was fetched). */
export async function fetchTicketFeeRatePercent(
  creds: WixCredentials,
  ticketDefinitionId: string
): Promise<number | null> {
  const reservation = await createWixTicketReservation(creds, ticketDefinitionId, 1);
  const line = reservation.lines.find((l) => l.ticketDefinitionId === ticketDefinitionId);
  return line?.serviceFee ? Number(line.serviceFee.rate) : null;
}

/** Wix's FEE_ADDED_AT_CHECKOUT service fee, applied to a cents amount and
 *  rounded to whole cents. The single source of this arithmetic, because the
 *  price a parent is *shown* and the amount Stripe actually *charges* are
 *  computed in two different places and have to agree to the cent.
 *
 *  The fee is added to the base rather than scaling by `(1 + rate/100)`, and
 *  multiplied before it is divided. Both matter: `1 + 2.5/100` is not exactly
 *  representable in binary, so `3500 * 1.025` evaluates to 3587.4999999999995
 *  and rounds DOWN to 3587, while adding the fee reaches an exact 3587.5 and
 *  rounds UP to 3588. That one-cent gap was live — a $35.87 ticket charged
 *  $35.88 at checkout.
 *
 *  Note this rounds per amount passed in, so a per-ticket price and a
 *  multi-ticket subtotal can still differ by a cent from each other
 *  (2 x round(35.875) = 71.76, round(71.75) = 71.75). Wix's own reservation
 *  subtotal stays the authority for what gets charged. */
function addTicketFeeCents(baseCents: number, feeRatePercent: number): number {
  return Math.round(baseCents + (baseCents * feeRatePercent) / 100);
}

/** The real price to show anywhere ahead of checkout — base ticket price
 *  plus Wix's own service fee when it applies, so nobody (buyer or vendor)
 *  is shown a total lower than what actually gets charged. Falls back to
 *  the bare price when the rate hasn't been discovered yet (see
 *  {@link fetchTicketFeeRatePercent}) — happens only for the brief window
 *  before a ticket type's first sync completes. */
export function ticketPriceWithFeeCents(
  priceCents: number,
  feeType: string | null,
  feeRatePercent: number | null
): number {
  if (feeType === 'FEE_ADDED_AT_CHECKOUT' && feeRatePercent != null) {
    return addTicketFeeCents(priceCents, feeRatePercent);
  }
  return priceCents;
}

export interface WixCheckoutGuest {
  firstName: string;
  lastName: string;
  email: string;
}

export interface WixCheckoutResult {
  orderNumber: string;
  status: string; // FREE | INITIATED | PAID | ...
  ticketsQuantity: number;
}

/** Converts a reservation into an order. Confirmed live that
 *  `options.markAsPaid: true` does NOT reliably move a paid ticket straight
 *  to `PAID` (it stayed `INITIATED` against a real event) — despite that
 *  being the documented behavior — so this never relies on it. A free
 *  ticket type (subTotal 0) comes back `FREE`/confirmed immediately with no
 *  further action needed; a paid one comes back `INITIATED` and needs
 *  {@link confirmWixEventOrder} once payment actually clears. `silent: true`
 *  suppresses Wix's own guest confirmation email — we send our own. */
export async function checkoutWixEventOrder(
  creds: WixCredentials,
  params: { eventId: string; reservationId: string; guest: WixCheckoutGuest }
): Promise<WixCheckoutResult> {
  const data = await wixFetch<{ order: { orderNumber: string; status: string; ticketsQuantity: number } }>(
    creds,
    '/events/v1/checkout',
    {
      eventId: params.eventId,
      reservationId: params.reservationId,
      buyer: {
        firstName: params.guest.firstName,
        lastName: params.guest.lastName,
        email: params.guest.email,
      },
      guests: [
        {
          form: {
            inputValues: [
              { inputName: 'firstName', value: params.guest.firstName },
              { inputName: 'lastName', value: params.guest.lastName },
              { inputName: 'email', value: params.guest.email },
            ],
          },
        },
      ],
      options: { silent: true },
    }
  );
  return {
    orderNumber: data.order.orderNumber,
    status: data.order.status,
    ticketsQuantity: data.order.ticketsQuantity,
  };
}

export interface WixConfirmedOrder {
  orderNumber: string;
  status: string;
  tickets: { ticketNumber: string; checkInUrl: string | null }[];
}

/** Moves an INITIATED/PENDING/OFFLINE_PENDING order to PAID — the real
 *  "payment cleared" signal for a Wix-linked ticket, called only from the
 *  Stripe webhook/reconcile once Stripe itself confirms the charge. Throws
 *  {@link WixApiError} with status 428 (ORDER_ACTION_NOT_AVAILABLE) if the
 *  order's reservation already expired or was otherwise no longer
 *  confirmable — callers must treat that as the same "paid but Wix lost the
 *  hold" race Bookings already handles, not a hard failure. */
export async function confirmWixEventOrder(
  creds: WixCredentials,
  eventId: string,
  orderNumber: string
): Promise<WixConfirmedOrder> {
  const data = await wixFetch<{
    orders: { orderNumber: string; status: string; tickets?: { ticketNumber: string; checkInUrl?: string }[] }[];
  }>(creds, `/events/v1/events/${eventId}/orders/confirm`, { orderNumber: [orderNumber] });
  const order = data.orders[0];
  return {
    orderNumber: order.orderNumber,
    status: order.status,
    tickets: (order.tickets ?? []).map((t) => ({ ticketNumber: t.ticketNumber, checkInUrl: t.checkInUrl ?? null })),
  };
}
