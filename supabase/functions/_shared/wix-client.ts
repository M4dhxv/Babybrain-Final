/**
 * Deno port of lib/wix/client.ts, trimmed to exactly what the 24/7
 * background sync (wix-sync/index.ts) needs — services, resources,
 * locations, events and ticket definitions/reservations. Everything about
 * *booking* (createWixBooking, checkout, availability grids, slot keys) is
 * deliberately left out: the scheduled sync never books anything, and those
 * functions stay on Vercel, reachable only from an authenticated vendor/
 * parent session.
 *
 * Kept byte-for-byte identical to the Vercel original wherever the logic
 * carries over, including the comments explaining WHY each piece of Wix's
 * API behaves the way it does — those are hard-won, and this file has to
 * agree with lib/wix/client.ts's behavior, not just its shape. If you change
 * one of the ported functions there, mirror the change here.
 *
 * The only real port work was two `Buffer` calls in the original file
 * (encodeWixSlotKey/decodeWixSlotKey) — neither is needed by the sync path,
 * so nothing here actually touches a Node-only API. Everything else (fetch,
 * Intl, plain TS) runs identically under Deno.
 */

const WIX_API_BASE = 'https://www.wixapis.com';

export interface WixCredentials {
  accessToken: string;
  siteId: string;
}

/** Thrown by {@link wixFetch} on a non-2xx response, carrying the raw HTTP
 *  status and body so callers can tell "wrong site ID" apart from "bad/
 *  revoked key" instead of one generic failure message. */
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
  // Bound every call so one hung Wix endpoint can't burn the whole function
  // budget and leave the run stuck. Surfaces as a WixApiError the callers
  // already handle (status 504 — not a 428/403/404, so it's reported, not
  // swallowed).
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 20_000);
  let res: Response;
  try {
    res = await fetch(`${WIX_API_BASE}${path}`, {
      method: 'POST',
      headers: wixHeaders(creds),
      body: JSON.stringify(body),
      signal: abort.signal,
    });
  } catch (e) {
    const timedOut = e instanceof Error && e.name === 'AbortError';
    throw new WixApiError(
      timedOut ? 504 : 0,
      path,
      timedOut ? 'Wix did not respond within 20s' : e instanceof Error ? e.message : 'network error',
    );
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new WixApiError(res.status, path, text);
  }
  return res.json() as Promise<T>;
}

export interface WixService {
  id: string;
  name: string;
  type: string;
  description?: string;
  locations?: { id: string; type: string; calculatedAddress?: { formattedAddress?: string; postalCode?: string } }[];
  payment?: {
    rateType?: string;
    fixed?: { price?: { value?: string; currency?: string } };
    varied?: {
      defaultPrice?: { value?: string; currency?: string };
      minPrice?: { value?: string; currency?: string };
      maxPrice?: { value?: string; currency?: string };
    };
  };
  defaultCapacity?: number;
  schedule?: { id?: string; firstSessionStart?: string; lastSessionEnd?: string };
  media?: {
    mainMedia?: { image?: { url?: string } };
    coverMedia?: { image?: { url?: string } };
    items?: { image?: { url?: string } }[];
  };
  staffMemberIds?: string[];
}

/** See lib/wix/client.ts's wixServicePrice — identical logic. */
export function wixServicePrice(service: WixService): number | null {
  const rateType = service.payment?.rateType;
  if (rateType === 'NO_FEE') return 0;
  if (rateType === 'FIXED') {
    const value = Number(service.payment?.fixed?.price?.value);
    return Number.isFinite(value) ? value : null;
  }
  if (rateType === 'VARIED') {
    const varied = service.payment?.varied;
    const min = Number(varied?.minPrice?.value);
    if (Number.isFinite(min)) return min;
    const fallback = Number(varied?.defaultPrice?.value);
    return Number.isFinite(fallback) ? fallback : null;
  }
  return null;
}

/** See lib/wix/client.ts's wixServiceCapacity — identical logic. */
export function wixServiceCapacity(service: WixService): number | null {
  const value = service.defaultCapacity;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function resolveWixMediaUrl(raw: string): string {
  if (/^https?:\/\//i.test(raw)) return raw;
  const filename = raw.replace(/^wix:image:\/\/v1\//i, '').split('/')[0].split('#')[0];
  return `https://static.wixstatic.com/media/${filename}`;
}

/** See lib/wix/client.ts's wixServiceImageUrl — identical logic. */
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

/** See lib/wix/client.ts's WixTimeSlot — identical shape. */
export interface WixTimeSlot {
  scheduleId?: string;
  serviceId: string;
  localStartDate: string;
  localEndDate: string;
  bookable: boolean;
  location?: { id?: string; name?: string; formattedAddress?: string; locationType?: string };
  availableResources?: { resourceTypeId?: string; resources?: { id: string; name?: string }[] }[];
  timeZone?: string;
}

/** See lib/wix/client.ts's wixLocalToUtcIso — identical logic. */
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
  const hour = parts.hour === '24' ? 0 : Number(parts.hour);
  const readAsUtc = Date.UTC(+parts.year, Number(parts.month) - 1, +parts.day, hour, +parts.minute, +parts.second);
  const offsetMs = readAsUtc - assumedUtc.getTime();
  return new Date(assumedUtc.getTime() - offsetMs).toISOString();
}

/** See lib/wix/client.ts's fetchWixCourseSpan — identical logic. */
export async function fetchWixCourseSpan(
  creds: WixCredentials,
  serviceId: string
): Promise<{ start: string | null; end: string | null }> {
  const data = await wixFetch<{ services?: WixService[] }>(creds, '/bookings/v2/services/query', {
    query: { filter: { id: serviceId }, paging: { limit: 1 } },
  });
  const svc = (data.services ?? []).find((s) => s.id === serviceId) ?? (data.services ?? [])[0];
  return {
    start: svc?.schedule?.firstSessionStart ?? null,
    end: svc?.schedule?.lastSessionEnd ?? null,
  };
}

/** See lib/wix/client.ts's fetchWixAvailability — identical logic (including
 *  the doc comment's warning: localStartDate/localEndDate are naive
 *  site-local wall-clock strings regardless of the `timezone` param, and
 *  must go through wixLocalToUtcIso using the response's own `timeZone`
 *  field before storage/display). */
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
    ...(ids.length > 0 ? { resourceIds: ids } : {}),
  });
  const timeZone = data.timeZone ?? 'UTC';
  return (data.timeSlots ?? []).map((s) => ({ ...s, timeZone }));
}

/** See lib/wix/client.ts's WixStaffMember/wixSlotStaff/formatWixStaffNames —
 *  identical logic. */
export interface WixStaffMember {
  id: string;
  name: string;
}

export function wixSlotStaff(slot: WixTimeSlot): WixStaffMember[] {
  const out: WixStaffMember[] = [];
  for (const group of slot.availableResources ?? []) {
    for (const r of group.resources ?? []) {
      if (r.id && r.name && !out.some((s) => s.id === r.id)) out.push({ id: r.id, name: r.name });
    }
  }
  return out;
}

export function formatWixStaffNames(
  staff: WixStaffMember[],
  knownStaffIds?: Set<string>
): string | null {
  const names = staff
    .filter((s) => !knownStaffIds || knownStaffIds.has(s.id))
    .map((s) => s.name.trim())
    .filter(Boolean);
  const unique = [...new Set(names)];
  if (unique.length === 0) return null;
  if (unique.length > 2) return `${unique[0]} +${unique.length - 1} more`;
  return unique.join(' & ');
}

/** See lib/wix/client.ts's selectNonOverlappingSlots — identical logic. */
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

/** See lib/wix/client.ts's WixClassSession/fetchWixClassSessions — identical
 *  logic. */
export interface WixClassSession {
  id: string;
  scheduleId: string;
  eventId: string;
  serviceId: string;
  start: string;
  end: string;
  capacity: number;
  remainingCapacity: number;
  staff: WixStaffMember[];
}

export interface WixClassSessionList {
  sessions: WixClassSession[];
  /** True only when Wix reported no further page after the last one we read.
   *  A caller may treat a session's ABSENCE from `sessions` as meaningful only
   *  when this is true — a truncated read makes every unread session look
   *  missing. */
  complete: boolean;
}

/** Upper bound on pages read per call (100 sessions each): a runaway cursor
 *  must not loop forever, and hitting it is reported as `complete: false`. */
const WIX_SESSION_MAX_PAGES = 20;

/** Every CONFIRMED occurrence for a CLASS/COURSE service over the next `days`
 *  days, plus whether Wix's whole calendar was read.
 *
 *  The query is account-wide (each session carries `scheduleOwnerId` = the
 *  service id, filtered client-side below), so a busy account can span several
 *  pages. It used to send `paging: { limit: 100 }`, which this endpoint ignores
 *  (confirmed live: limit 5 still returned all 11) — so only Wix's default
 *  first page was ever read, and anything past it looked like it had vanished.
 *  `cursorPaging` is the mechanism the endpoint actually honours. */
export async function fetchWixClassSessionList(creds: WixCredentials, serviceId: string, days = 7): Promise<WixClassSessionList> {
  const now = new Date();
  const to = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const fromDate = now.toISOString();
  const toDate = to.toISOString();

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
    // Every other calendar this occurrence blocks out. For a CLASS/COURSE
    // that's the staff assigned to teach it — confirmed live: a Kathak class
    // comes back with `scheduleOwnerId` = the instructor's resource id and
    // `scheduleOwnerName` = "Madhav". It is the ONLY place the sessions query
    // names the person taking the session; the top-level `scheduleOwnerName`
    // is the *service's* name ("Kathak Classes"), not a staff member's.
    affectedSchedules?: { scheduleOwnerId?: string; scheduleOwnerName?: string }[];
  }
  const raw: RawSession[] = [];
  let cursor: string | undefined;
  let complete = false;
  for (let page = 0; page < WIX_SESSION_MAX_PAGES; page++) {
    const data = await wixFetch<{
      sessions?: RawSession[];
      pagingMetadata?: { hasNext?: boolean; cursors?: { next?: string } };
    }>(creds, '/bookings/v2/calendar/sessions/query', {
      query: { cursorPaging: cursor ? { limit: 100, cursor } : { limit: 100 } },
      fromDate,
      toDate,
    });
    raw.push(...(data.sessions ?? []));
    const next = data.pagingMetadata?.cursors?.next;
    if (!data.pagingMetadata?.hasNext) { complete = true; break; }
    if (!next) break; // Wix says more exist but gave no way to reach them
    cursor = next;
  }
  const sessions = raw
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
      staff: (s.affectedSchedules ?? [])
        .filter((a): a is { scheduleOwnerId: string; scheduleOwnerName: string } =>
          !!a.scheduleOwnerId && !!a.scheduleOwnerName)
        .map((a) => ({ id: a.scheduleOwnerId, name: a.scheduleOwnerName })),
    }));
  return { sessions, complete };
}

/** Every occurrence for a CLASS/COURSE service over the next `days` days,
 *  full or not — callers that only want bookable ones must filter on
 *  `.remainingCapacity > 0` themselves. */
export async function fetchWixClassSessions(creds: WixCredentials, serviceId: string, days = 7): Promise<WixClassSession[]> {
  return (await fetchWixClassSessionList(creds, serviceId, days)).sessions;
}

export type WixSessionLiveness = 'active' | 'cancelled' | 'unknown';

/** Asks Wix directly about ONE calendar session, by id — the definitive answer
 *  to "did the vendor cancel this?", which a session merely being absent from
 *  a list is not (a truncated page, a transient error and a real cancellation
 *  all look identical there).
 *
 *   - 'cancelled': Wix has no such session (404) or reports it CANCELLED.
 *   - 'active':    Wix reports it CONFIRMED.
 *   - 'unknown':   anything else — a timeout, a 5xx, a 4xx that isn't a plain
 *                  "not found", an unfamiliar status. The caller must treat it
 *                  as "don't act", never as cancelled. */
export async function fetchWixSessionLiveness(creds: WixCredentials, sessionId: string): Promise<WixSessionLiveness> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 20_000);
  try {
    const res = await fetch(`${WIX_API_BASE}/bookings/v2/calendar/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'GET',
      headers: wixHeaders(creds),
      signal: abort.signal,
    });
    if (res.status === 404) return 'cancelled';
    if (!res.ok) return 'unknown';
    const body = (await res.json().catch(() => null)) as { session?: { status?: string } } | null;
    const status = body?.session?.status;
    if (status === 'CONFIRMED') return 'active';
    if (status === 'CANCELLED' || status === 'CANCELED') return 'cancelled';
    return 'unknown';
  } catch {
    return 'unknown';
  } finally {
    clearTimeout(timer);
  }
}

/** See lib/wix/client.ts's WixSlotKey/encodeWixSlotKey — same shape and
 *  encoding (base64url of the JSON payload), so a key written by either
 *  runtime matches the other exactly. The original uses Node's `Buffer`;
 *  this file avoids Node-only APIs (see the module doc), so this encodes via
 *  the same web-standard `btoa` this Deno runtime already has, converted to
 *  base64url by hand (`+`/`/` -> `-`/`_`, padding stripped) — byte-for-byte
 *  the same output `Buffer.from(json).toString('base64url')` produces.
 *  Decoding is ported too (below) so the sync can recover a class session's
 *  Wix id from a stored key when it needs to ask Wix about that one session. */
export type WixSlotKey =
  | { kind: 'appointment'; s: string; e: string; loc: string }
  | { kind: 'class'; sessionId: string };

export function encodeWixSlotKey(payload: WixSlotKey): string {
  const json = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeWixSlotKey(key: string): WixSlotKey {
  const b64 = key.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** See lib/wix/client.ts's courseAnchorSlotKey — identical logic. */
export function courseAnchorSlotKey(scheduleId: string): string {
  return `wixcourse:${scheduleId}`;
}

/** See lib/wix/client.ts's WixConfirmedBooking/fetchWixConfirmedAppointmentBookings
 *  — identical logic. */
export interface WixConfirmedBooking {
  id: string;
  start: string;
  end: string;
}

export async function fetchWixConfirmedAppointmentBookings(creds: WixCredentials, serviceId: string): Promise<WixConfirmedBooking[]> {
  interface RawBooking {
    id: string;
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
    .map((b) => ({ id: b.id, start: b.startDate!, end: b.endDate! }));
}

export interface WixLocation {
  id: string;
  name: string;
  address: string | null;
  postalCode: string | null;
  isDefault: boolean;
}

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

export interface WixEvent {
  id: string;
  title: string;
  slug: string;
  status: string;
  startDate: string;
  endDate: string;
  timeZoneId?: string;
  location: {
    name: string | null;
    type: string | null;
    city: string | null;
    postalCode: string | null;
    formattedAddress: string | null;
    locationTbd: boolean;
  };
  mainImageUrl: string | null;
  description: string;
}

/** See lib/wix/client.ts's fetchWixEvents — identical logic, including the
 *  server-side date-window paging and the $and workaround for Wix's filter
 *  parser. */
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
  const MAX_EVENTS = PAGE_SIZE * 10;

  const raw: RawEvent[] = [];
  for (let offset = 0; offset < MAX_EVENTS; offset += PAGE_SIZE) {
    const data = await wixFetch<{ events?: RawEvent[] }>(creds, '/events/v3/events/query', {
      query: {
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
    if (page.length < PAGE_SIZE) break;
  }

  return raw
    .filter((e) => e.status !== 'CANCELED')
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
  priceValue: string | null;
  currency: string | null;
  limitPerCheckout: number | null;
  hidden: boolean;
  saleStatus: string;
  saleStartDate: string | null;
  saleEndDate: string | null;
  initialLimit: number | null;
  unsoldCount: number | null;
  soldOut: boolean;
  feeType: string | null;
}

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
  serviceFee: { type: string; rate: string } | null;
}

export interface WixTicketReservation {
  id: string;
  status: string;
  expirationDate: string | null;
  lines: WixTicketReservationLine[];
}

/** Only ever called here for {@link fetchTicketFeeRatePercent}'s throwaway
 *  hold — never to actually reserve a real ticket, which stays a Vercel-only,
 *  authenticated-checkout operation. */
async function createWixTicketReservation(
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

/** See lib/wix/client.ts's fetchTicketFeeRatePercent — identical logic
 *  (a throwaway quantity-1 reservation is the only place Wix exposes the fee
 *  rate; the hold releases itself in 20-30 min). */
export async function fetchTicketFeeRatePercent(
  creds: WixCredentials,
  ticketDefinitionId: string
): Promise<number | null> {
  const reservation = await createWixTicketReservation(creds, ticketDefinitionId, 1);
  const line = reservation.lines.find((l) => l.ticketDefinitionId === ticketDefinitionId);
  return line?.serviceFee ? Number(line.serviceFee.rate) : null;
}

function addTicketFeeCents(baseCents: number, feeRatePercent: number): number {
  return Math.round(baseCents + (baseCents * feeRatePercent) / 100);
}

/** See lib/wix/client.ts's ticketPriceWithFeeCents — identical logic. */
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
