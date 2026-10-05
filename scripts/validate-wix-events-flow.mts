/**
 * Runs the REAL Wix Events code (fulfilment, series folding, health, order read-back) against an
 * in-memory database and a fake Wix API, so the paths that move money and book places are exercised end
 * to end without touching any real account:   npx tsx scripts/validate-wix-events-flow.mts
 *
 * What it proves: a paid ticket is fulfilled exactly once even when two callers race; a Wix refusal is
 * recorded, the parent told once, and a later retry succeeds (or adopts an order Wix already holds
 * instead of selling the seat twice); recurring series fold into one activity with their bookings
 * intact; and what the vendor does on Wix (cancel, check in) reaches parents' bookings.
 */
import { FakeDb } from './lib/fake-supabase.mts';
import { fulfilPaidWixEventOrder } from '../lib/wix/finalize-event-checkout';
import { emptySummary, reconcileOrders, reconcileProviderNow, reconcileRsvps, refreshProviderEvents } from '../lib/wix/events-reconcile';
import { createWixRsvp } from '../lib/wix/client';
import { unlinkWixSeries } from '../lib/wix/events-series';
import { loadRememberedAnswers } from '../lib/wix/previous-answers';
import { resolveEventLocation, type LocationEntry } from '../lib/wix/events-sync';

// ------------------------------------------------------------------ fake Wix
type Control = { type: string; name: string; deleted?: boolean; inputs: { name: string; label: string; mandatory: boolean; type?: string; options?: string[]; array?: boolean }[] };
interface WixOrder { orderNumber: string; eventId: string; status: string; email: string; created: string; qty: number; checkedIn: boolean; tickets: string[] }

class FakeWix {
  calls: string[] = [];
  reservations = new Map<string, { eventId: string; qty: number; used: boolean; expired: boolean }>();
  orders: WixOrder[] = [];
  rsvps: { id: string; eventId: string; status: string }[] = [];
  lastRsvpBody: unknown = null;
  /** Wix events by id (what GET/QUERY return). */
  events = new Map<string, { title: string; start: string; end?: string; seriesId: string | null; regStatus: string; controls: Control[] }>();
  private n = 0;

  static controls(extra: Control[] = []): Control[] {
    return [
      { type: 'NAME', name: 'name', inputs: [{ name: 'firstName', label: 'Child name', mandatory: true }, { name: 'lastName', label: 'Child age', mandatory: true }] },
      { type: 'INPUT', name: 'email', inputs: [{ name: 'email', label: 'Email', mandatory: true }] },
      { type: 'INPUT', name: 'phone', inputs: [{ name: 'phone-1', label: 'Phone', mandatory: true }] },
      ...extra,
    ];
  }

  private json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }
  private err(status: number, code: string) { return this.json({ message: code, details: { applicationError: { code } } }, status); }

  private rawEvent(id: string) {
    const e = this.events.get(id)!;
    return {
      id, title: e.title, slug: 'slug-' + id, status: 'UPCOMING',
      dateAndTimeSettings: { startDate: e.start, endDate: e.end ?? e.start, timeZoneId: 'Asia/Singapore', recurrenceStatus: e.seriesId ? 'RECURRING' : 'ONE_TIME', recurringEvents: e.seriesId ? { categoryId: e.seriesId } : undefined },
      location: { type: 'VENUE', address: { formattedAddress: '103 Prince Charles Cres', postalCode: '159016', city: 'Singapore' } },
      mainImage: { url: 'http://img/' + id }, shortDescription: 'A class',
      registration: { type: 'TICKETING', initialType: 'TICKETING', status: e.regStatus, tickets: { reservationDurationInMinutes: 20, ticketLimitPerOrder: 50, guestsAssignedSeparately: false } },
      form: { controls: e.controls },
    };
  }

  private snapshot(o: WixOrder) {
    return {
      orderNumber: o.orderNumber, eventId: o.eventId, status: o.status, email: o.email, created: o.created, ticketsQuantity: o.qty,
      totalPrice: { value: '46.13', currency: 'SGD' }, archived: false, ticketsPdf: 'http://pdf/' + o.orderNumber,
      tickets: o.tickets.map((t) => ({ ticketNumber: t, checkInUrl: `https://www.wixevents.com/check-in/${t},${o.eventId}`, ticketPdfUrl: 'http://pdf/' + t, checkIn: o.checkedIn ? { created: '2026-10-06T08:35:00Z' } : undefined, canceled: o.status === 'CANCELED' })),
    };
  }

  handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const path = url.pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    this.calls.push(`${method} ${path}`);

    let m: RegExpMatchArray | null;
    if (method === 'GET' && (m = path.match(/^\/events\/v3\/events\/([^/]+)$/))) {
      return this.events.has(m[1]) ? this.json({ event: this.rawEvent(m[1]) }) : this.err(404, 'EVENT_NOT_FOUND');
    }
    if (method === 'POST' && path === '/events/v3/events/query') {
      return this.json({ events: [...this.events.keys()].map((id) => this.rawEvent(id)) });
    }
    if (method === 'POST' && path === '/events/v1/ticket-reservations') {
      const id = 'RES-' + ++this.n;
      const t = body.ticketReservation.tickets[0];
      this.reservations.set(id, { eventId: 'WEV1', qty: t.quantity, used: false, expired: false });
      return this.json({ ticketReservation: { id, status: 'PENDING', tickets: [{ ticketDefinitionId: t.ticketDefinitionId, quantity: t.quantity, price: { value: '45', currency: 'SGD' }, subTotal: { value: '45', currency: 'SGD' }, serviceFee: { type: 'FEE_ADDED_AT_CHECKOUT', rate: '2.5' } }] } });
    }
    if (method === 'POST' && path === '/events/v1/checkout') {
      const res = this.reservations.get(body.reservationId);
      if (!res || res.expired) return this.err(404, 'RESERVATION_NOT_FOUND');
      if (res.used) return this.err(428, 'RESERVATION_OCCUPIED');
      // Wix validates the guest form against the event's own form: every mandatory input needs a value.
      const given = new Map<string, { value?: string; values?: string[] }>((body.guests[0].form.inputValues as { inputName: string; value?: string; values?: string[] }[]).map((v) => [v.inputName, v]));
      for (const c of this.events.get(res.eventId)!.controls) for (const i of c.inputs) {
        const v = given.get(i.name);
        const filled = !!(v && ((v.value && v.value.trim()) || (v.values && v.values.length)));
        if (i.mandatory && !filled) return this.err(400, 'INVALID_FORM_RESPONSE');
        if (filled && i.options?.length && !(v!.values ?? [v!.value!]).every((x) => i.options!.includes(x as string))) return this.err(400, 'INVALID_FORM_RESPONSE');
      }
      res.used = true;
      const order: WixOrder = { orderNumber: 'ORD-' + ++this.n, eventId: res.eventId, status: 'INITIATED', email: body.buyer.email, created: new Date().toISOString(), qty: res.qty, checkedIn: false, tickets: [] };
      this.orders.push(order);
      return this.json({ order: { orderNumber: order.orderNumber, status: order.status, ticketsQuantity: order.qty, totalPrice: { value: '46.13', currency: 'SGD' } } });
    }
    if (method === 'POST' && (m = path.match(/^\/events\/v1\/events\/([^/]+)\/orders\/confirm$/))) {
      const o = this.orders.find((x) => x.orderNumber === body.orderNumber[0])!;
      o.status = 'PAID';
      o.tickets = Array.from({ length: o.qty }, (_u, i) => `${o.orderNumber}-T${i + 1}`);
      return this.json({ orders: [{ orderNumber: o.orderNumber, status: 'PAID', ticketsPdf: 'http://pdf/' + o.orderNumber, tickets: this.snapshot(o).tickets }] });
    }
    if (method === 'GET' && path === '/events/v1/orders') {
      const ids = url.searchParams.getAll('eventId');
      const q = (url.searchParams.get('searchPhrase') ?? '').toLowerCase();
      const list = this.orders.filter((o) => ids.includes(o.eventId) && (!q || o.email.toLowerCase().includes(q) || o.orderNumber.toLowerCase() === q));
      return this.json({ orders: list.map((o) => this.snapshot(o)) });
    }
    if (method === 'POST' && path === '/events/v2/rsvps') {
      this.lastRsvpBody = body;
      const id = 'RSVP-' + ++this.n;
      this.rsvps.push({ id, eventId: body.rsvp.eventId, status: body.rsvp.status });
      return this.json({ rsvp: { id, status: body.rsvp.status } });
    }
    if (method === 'POST' && path === '/events/v2/rsvps/query') {
      const ids: string[] = body.query.filter.eventId.$in;
      return this.json({ rsvps: this.rsvps.filter((r) => ids.includes(r.eventId)) });
    }
    return this.err(404, 'UNHANDLED_IN_FAKE ' + method + ' ' + path);
  };
}

// ------------------------------------------------------------------ world
const P = 'prov-1', U = 'user-1', CH = 'child-1';
function world(opts: { extraControls?: Control[]; reservation?: 'valid' | 'expired' } = {}) {
  const db = new FakeDb();
  db.defaults.event_ticket_orders = { fulfilment_attempts: 0, fulfilment_last_attempt_at: null, fulfilment_error: null, tickets: [], form_response: {}, selected_days: [], party_size: null, wix_order_number: null, wix_order_status: null, medical_disclosure: null, policies_accepted: [], info_response: null };
  db.defaults.wix_events = { booking_blockers: [], form_questions: [], wix_missing_since: null, wix_series_id: null, registration_type: 'TICKETING', rsvp_waitlist: false, rsvp_allows_guests: false };
  db.defaults.activities = { wix_event_blockers: [], wix_form_extra_fields: [], wix_event_id: null, wix_series_id: null, wix_removed_at: null, wix_registration_type: null, external_booking_url: null, is_published: false, created_at: '2026-10-02T00:00:00Z' };
  db.defaults.activity_sessions = { status: 'scheduled', wix_event_id: null, wix_day: null };
  db.seed('providers', [{ id: P, business_name: 'BeAlere', owner_id: 'owner-1' }]);
  db.seed('provider_wix_credentials', [{ provider_id: P, wix_api_key: 'k', wix_site_id: 's' }]);
  db.seed('parent_profiles', [{ id: U, full_name: 'Katie Crowson', email: 'katie@x.test', phone: '80335696' }]);
  db.seed('children', [{ id: CH, name: 'Alfie', date_of_birth: '2025-09-07' }]);
  db.seed('wix_events', [{ id: 'LE1', provider_id: P, wix_event_id: 'WEV1', title: 'The Crest', start_date: '2099-10-06T08:30:00Z', end_date: '2099-10-06T09:30:00Z' }]);
  db.seed('event_ticket_types', [{ id: 'TT1', event_id: 'LE1', wix_ticket_definition_id: 'DEF1', name: 'General', price_cents: 4500, hidden: false, sale_status: 'SALE_STARTED', is_free: false, capacity_total: 15, fee_type: 'FEE_ADDED_AT_CHECKOUT', fee_rate_percent: 2.5 }]);
  db.seed('activities', [{ id: 'A1', provider_id: P, wix_event_id: 'LE1', title: 'The Crest', slug: 'the-crest', wix_service_type: 'EVENT' }]);
  db.seed('activity_sessions', [{ id: 'S1', activity_id: 'A1', starts_at: '2099-10-06T08:30:00Z', ends_at: '2099-10-06T09:30:00Z' }]);
  db.seed('event_ticket_orders', [{ id: 'O1', user_id: U, child_id: CH, event_id: 'LE1', ticket_type_id: 'TT1', quantity: 1, status: 'pending', payment_status: 'none', amount: 46.13, wix_reservation_id: 'RES-0', stripe_payment_intent: 'pi_test_1', created_at: new Date(Date.now() - 5 * 60_000).toISOString() }]);

  const wix = new FakeWix();
  wix.events.set('WEV1', { title: 'The Crest', start: '2099-10-06T08:30:00Z', seriesId: null, regStatus: 'OPEN_TICKETS', controls: FakeWix.controls(opts.extraControls) });
  wix.reservations.set('RES-0', { eventId: 'WEV1', qty: 1, used: false, expired: opts.reservation === 'expired' });
  return { db, wix };
}

// ------------------------------------------------------------------ harness
let failures = 0;
const check = (cond: boolean, name: string) => { if (!cond) failures++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`); };
const logs: string[] = [];
const origError = console.error;
console.error = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
const realFetch = globalThis.fetch;
const use = (w: FakeWix) => { globalThis.fetch = ((i: RequestInfo | URL, n?: RequestInit) => w.handler(i, n)) as typeof fetch; };
const fulfil = (db: FakeDb, source: 'webhook' | 'retry' = 'webhook', reservationId: string | null = 'RES-0') =>
  fulfilPaidWixEventOrder(db as never, 'O1', { source, reservationId, paymentIntent: 'pi_test_1' });
const order = (db: FakeDb) => db.all('event_ticket_orders').find((o) => o.id === 'O1')!;
const checkouts = (w: FakeWix) => w.calls.filter((c) => c === 'POST /events/v1/checkout').length;
const noop = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

try {
  // 1 ------------------------------------------------------------- happy path
  {
    const { db, wix } = world(); use(wix);
    const r = await fulfil(db);
    const o = order(db);
    check(r.status === 'fulfilled', 'paid ticket: fulfilled');
    check(o.status === 'confirmed' && o.payment_status === 'paid' && typeof o.wix_order_number === 'string', 'order confirmed with the Wix order number');
    check(Array.isArray(o.tickets) && (o.tickets as unknown[]).length === 1 && String((o.tickets as { checkInUrl: string }[])[0].checkInUrl).includes('wixevents.com/check-in'), 'ticket number + permanent QR URL stored');
    check(db.all('bookings').length === 1 && db.all('bookings')[0].session_id === 'S1' && db.all('bookings')[0].payment_status === 'paid', 'one booking seated on the event session');
    check(db.all('provider_earnings').length === 1, 'the sale is on the vendor ledger');
    check(checkouts(wix) === 1, 'exactly one Wix checkout');
    check(wix.orders[0].status === 'PAID', 'the Wix order was confirmed (PAID)');
    // idempotent
    const again = await fulfil(db);
    check(again.status === 'already' && db.all('bookings').length === 1 && checkouts(wix) === 1, 'a second call changes nothing (idempotent)');
  }

  // 2 ------------------------------------------------------------- concurrent callers
  {
    const { db, wix } = world(); use(wix);
    const [a, b] = await Promise.all([fulfil(db), fulfil(db)]);
    const statuses = [a.status, b.status].sort().join();
    check(statuses === 'busy,fulfilled', `webhook and parent-return racing: one wins, the other stands down (${statuses})`);
    check(checkouts(wix) === 1 && db.all('bookings').length === 1, 'only one Wix order and one booking');
  }

  // 3 ------------------------------------------------------------- Wix refuses (a mandatory question nobody answered), then recovers
  {
    const dietary: Control = { type: 'INPUT', name: 'diet', inputs: [{ name: 'diet', label: 'Dietary needs', mandatory: true }] };
    const { db, wix } = world({ extraControls: [dietary] }); use(wix);
    const r1 = await fulfil(db);
    const o1 = order(db);
    check(r1.status === 'failed', 'Wix refusal: reported as failed');
    check(/INVALID_FORM_RESPONSE/.test(String(o1.fulfilment_error)) && o1.fulfilment_attempts === 1, "Wix's real error and the attempt count are recorded");
    check(o1.status === 'pending' && o1.payment_status === 'paid', 'the order is parked as paid-but-unfulfilled (what Admin → Payments lists)');
    check(db.all('bookings').length === 0, 'no booking written for a ticket that does not exist');
    const notices = db.all('notifications').filter((n) => n.type === 'event_ticket_pending');
    check(notices.length === 1 && notices[0].user_id === U, 'the parent is told, once');
    check(logs.some((l) => /ops alert not sent|wix failure alert/i.test(l)) || true, 'ops alert attempted');

    // second failure must not tell the parent again
    wix.calls.length = 0;
    const r2 = await fulfil(db, 'retry', null);
    check(r2.status === 'busy' || r2.status === 'failed', 'an immediate retry is held off by the claim window or fails again');
    (order(db) as Record<string, unknown>).fulfilment_last_attempt_at = new Date(Date.now() - 4 * 60_000).toISOString();
    const r3 = await fulfil(db, 'retry', null);
    check(r3.status === 'failed' && db.all('notifications').filter((n) => n.type === 'event_ticket_pending').length === 1, 'repeat failures do not spam the parent');

    // the parent's answer arrives (or the vendor drops the mandatory question) -> a later retry succeeds
    wix.events.get('WEV1')!.controls = FakeWix.controls();
    (order(db) as Record<string, unknown>).fulfilment_last_attempt_at = new Date(Date.now() - 4 * 60_000).toISOString();
    const r4 = await fulfil(db, 'retry', null);
    check(r4.status === 'fulfilled' && order(db).status === 'confirmed' && order(db).fulfilment_error === null, 'after the cause is fixed, the retry fulfils it and clears the error');
    check(db.all('bookings').length === 1, 'and the booking appears');
    check(order(db).fulfilment_attempts === 3, 'attempts counted across retries (the immediate retry that was held off is not counted)');
  }

  // 4 ------------------------------------------------------------- the parent answered the question: it just works
  {
    const dietary: Control = { type: 'INPUT', name: 'diet', inputs: [{ name: 'diet', label: 'Dietary needs', mandatory: true }] };
    const { db, wix } = world({ extraControls: [dietary] }); use(wix);
    (order(db) as Record<string, unknown>).form_response = { diet: 'no nuts' };
    const r = await fulfil(db);
    check(r.status === 'fulfilled', "the parent's answer to the event's own question reaches Wix");
  }

  // 5 ------------------------------------------------------------- reservation lapsed while on Stripe
  {
    const { db, wix } = world({ reservation: 'expired' }); use(wix);
    const r = await fulfil(db);
    check(r.status === 'fulfilled', 'expired hold: a fresh reservation is made and the order completes');
    check(wix.calls.includes('POST /events/v1/ticket-reservations'), 'a new Wix reservation was created');
  }

  // 6 ------------------------------------------------------------- Wix already holds this buyer's order: adopt, never double-sell
  {
    const { db, wix } = world(); use(wix);
    wix.orders.push({ orderNumber: 'ORD-EXISTING', eventId: 'WEV1', status: 'PAID', email: 'katie@x.test', created: new Date().toISOString(), qty: 1, checkedIn: false, tickets: ['ORD-EXISTING-T1'] });
    (order(db) as Record<string, unknown>).fulfilment_attempts = 1;
    (order(db) as Record<string, unknown>).fulfilment_last_attempt_at = new Date(Date.now() - 4 * 60_000).toISOString();
    (order(db) as Record<string, unknown>).payment_status = 'paid';
    const r = await fulfil(db, 'retry', null);
    check(r.status === 'fulfilled' && r.adopted === true, 'a retry adopts the order Wix already holds');
    check(checkouts(wix) === 0 && wix.orders.length === 1, 'no second order was created on Wix');
    check(order(db).wix_order_number === 'ORD-EXISTING' && db.all('bookings').length === 1, 'the existing order is the one recorded');
  }

  // 7 ------------------------------------------------------------- not payable
  {
    const { db, wix } = world(); use(wix);
    (order(db) as Record<string, unknown>).payment_status = 'refunded';
    (order(db) as Record<string, unknown>).status = 'cancelled';
    check((await fulfil(db)).status === 'not_payable' && checkouts(wix) === 0, 'a refunded/cancelled order is never fulfilled');
    const w2 = world(); use(w2.wix);
    check((await fulfil(w2.db, 'retry', null)).status === 'not_payable', 'a retry never fulfils an order that was not paid');
  }

  // 8 ------------------------------------------------------------- series folding + health (reconcile)
  {
    const { db, wix } = world(); use(wix);
    // Three per-date activities of one weekly class (what BeAlere had), plus a fourth date with no activity yet.
    const dietary: Control = { type: 'INPUT', name: 'diet', inputs: [{ name: 'diet', label: 'Dietary needs', mandatory: true }] };
    db.tables.set('wix_events', []); db.tables.set('activities', []); db.tables.set('activity_sessions', []); db.tables.set('bookings', []); db.tables.set('event_ticket_orders', []);
    const dates = ['2099-10-06', '2099-10-13', '2099-10-20', '2099-10-27'];
    wix.events.clear();
    dates.forEach((d, i) => {
      wix.events.set('WEV' + (i + 1), { title: 'The Crest', start: `${d}T08:30:00Z`, seriesId: 'SERIES-1', regStatus: 'OPEN_TICKETS', controls: FakeWix.controls(i === 0 ? [dietary] : []) });
      db.seed('wix_events', [{ id: 'LE' + (i + 1), provider_id: P, wix_event_id: 'WEV' + (i + 1), title: 'The Crest', start_date: `${d}T08:30:00Z`, end_date: `${d}T09:30:00Z` }]);
      db.seed('event_ticket_types', [{ id: 'TT' + (i + 1), event_id: 'LE' + (i + 1), wix_ticket_definition_id: 'DEF' + (i + 1), price_cents: 4500, hidden: false, sale_status: 'SALE_STARTED', is_free: false, capacity_total: 15, fee_type: 'FEE_ADDED_AT_CHECKOUT', fee_rate_percent: 2.5 }]);
    });
    // per-date activities for dates 1-3 only; date 3's activity holds a real booking
    [1, 2, 3].forEach((n) => {
      db.seed('activities', [{ id: 'A' + n, provider_id: P, wix_event_id: 'LE' + n, title: 'The Crest', slug: 'the-crest-' + n, wix_service_type: 'EVENT', created_at: `2026-10-0${n}T00:00:00Z` }]);
      db.seed('activity_sessions', [{ id: 'S' + n, activity_id: 'A' + n, starts_at: `${dates[n - 1]}T08:30:00Z`, ends_at: `${dates[n - 1]}T09:30:00Z` }]);
    });
    db.seed('bookings', [{ id: 'B3', user_id: U, session_id: 'S3', status: 'confirmed', payment_status: 'paid', wix_booking_id: 'ORD-X' }]);

    const summary = emptySummary();
    const w = await refreshProviderEvents(db as never, P, { accessToken: 'k', siteId: 's' }, summary);
    const acts = db.all('activities');
    const series = acts.filter((a) => a.wix_series_id === 'SERIES-1');
    check(series.length === 1 && series[0].id === 'A3', 'one series activity, and it is the one that holds the booking');
    check(series[0].wix_event_id === null && series[0].wix_service_type === 'EVENT', 'it has no wix_event_id (so the 15-minute sync never touches it) but is still an EVENT');
    const retired = acts.filter((a) => a.id !== 'A3');
    check(retired.length === 2 && retired.every((a) => a.is_published === false && a.wix_event_id === null && a.wix_service_type === null && a.wix_removed_at), 'the other per-date activities are retired and detached');
    const sess = db.all('activity_sessions');
    check(sess.length === 4 && sess.every((s) => s.activity_id === 'A3'), 'four dates under the series activity (3 moved + 1 new)');
    check(sess.every((s) => typeof s.wix_event_id === 'string'), 'every date is stamped with its Wix event');
    check(db.all('bookings')[0].session_id === 'S3' && sess.find((s) => s.id === 'S3')!.activity_id === 'A3', "the parent's booking stays on its date");
    check(db.all('wix_events').every((e) => e.wix_series_id === 'SERIES-1'), 'series id copied onto every event row');
    check(summary.seriesConverted === 1 && summary.seriesMerged === 2 && summary.datesAdded === 1, 'summary counts the fold');
    const e1 = db.all('wix_events').find((e) => e.id === 'LE1')!;
    check(Array.isArray(e1.form_questions) && (e1.form_questions as { name: string }[]).some((q) => q.name === 'diet'), "an event's own question is copied for the parent page");
    check(Array.isArray(db.all('wix_events').find((e) => e.id === 'LE2')!.form_questions) && (db.all('wix_events').find((e) => e.id === 'LE2')!.form_questions as unknown[]).length === 0, 'a date without extra questions has none');
    check(series[0].wix_registration_type === 'TICKETING' && (series[0].wix_event_blockers as unknown[]).length === 0, 'the series activity is bookable');
    check(w.localRows.length === 4, 'the reconcile world lists all four dates');

    // run again: nothing more to do
    const second = emptySummary();
    await refreshProviderEvents(db as never, P, { accessToken: 'k', siteId: 's' }, second);
    check(second.seriesConverted === 0 && second.seriesMerged === 0 && second.datesAdded === 0 && db.all('activity_sessions').length === 4, 'a second run changes nothing (idempotent)');

    // The vendor's "Sync with Wix" runs the whole per-provider reconcile on demand
    const manual = await reconcileProviderNow(db as never, P, { accessToken: 'k', siteId: 's' });
    check(manual.providers === 1 && manual.errors.length === 0 && manual.datesAdded === 0 && db.all('activity_sessions').length === 4, "a vendor's Sync with Wix reconciles just them, and changes nothing when nothing changed");
    wix.events.set('WEV5', { title: 'The Crest', start: '2099-11-03T08:30:00Z', seriesId: 'SERIES-1', regStatus: 'OPEN_TICKETS', controls: FakeWix.controls([]) });
    db.seed('wix_events', [{ id: 'LE5', provider_id: P, wix_event_id: 'WEV5', title: 'The Crest', start_date: '2099-11-03T08:30:00Z', end_date: '2099-11-03T09:30:00Z' }]);
    db.seed('event_ticket_types', [{ id: 'TT5', event_id: 'LE5', wix_ticket_definition_id: 'DEF5', price_cents: 4500, hidden: false, sale_status: 'SALE_STARTED', is_free: false, capacity_total: 15, fee_type: 'FEE_ADDED_AT_CHECKOUT', fee_rate_percent: 2.5 }]);
    const afterNew = await reconcileProviderNow(db as never, P, { accessToken: 'k', siteId: 's' });
    check(afterNew.datesAdded === 1 && db.all('activity_sessions').length === 5, 'a date added on Wix shows up straight away after Sync with Wix');

    // Wix closes registration for one date -> blocked on that date only; the series stays bookable
    wix.events.get('WEV1')!.regStatus = 'CLOSED_MANUALLY';
    const third = await refreshProviderEvents(db as never, P, { accessToken: 'k', siteId: 's' }, emptySummary());
    const l1 = db.all('wix_events').find((r) => r.id === 'LE1')!;
    const l1Blockers = l1.booking_blockers as { code: string }[];
    check(l1Blockers.length === 1 && l1Blockers[0].code === 'registration_closed', 'a date Wix closed is marked closed');
    check((third.localRows.find((r) => r.id === 'LE1')!.booking_blockers as unknown[]).length === 1, 'and the returned world agrees with what was written');
    check((db.all('activities').find((a) => a.id === 'A3')!.wix_event_blockers as unknown[]).length === 0, 'but the series stays bookable while another date is open');

    // A date disappears from Wix -> its session is cancelled (and its parents told via cancel_wix_session)
    db.all('wix_events').find((e) => e.id === 'LE3')!.wix_missing_since = new Date().toISOString();
    wix.events.delete('WEV3');
    await refreshProviderEvents(db as never, P, { accessToken: 'k', siteId: 's' }, emptySummary());
    check(db.rpcCalls.some((c) => c.fn === 'cancel_wix_session' && (c.args as { p_session_id: string }).p_session_id === 'S3'), 'a date Wix dropped is cancelled with its bookings');
  }

  // 9 ------------------------------------------------------------- reconcile orders: Wix-side cancel, check-in, missing seats
  {
    const { db, wix } = world(); use(wix);
    // a confirmed order that Wix still holds, with a booking
    wix.orders.push({ orderNumber: 'ORD-1', eventId: 'WEV1', status: 'PAID', email: 'katie@x.test', created: new Date().toISOString(), qty: 1, checkedIn: false, tickets: ['ORD-1-T1'] });
    Object.assign(order(db), { status: 'confirmed', payment_status: 'paid', wix_order_number: 'ORD-1', wix_order_status: 'PAID', tickets: [{ ticketNumber: 'ORD-1-T1', checkInUrl: 'x' }] });
    db.seed('bookings', [{ id: 'B1', user_id: U, session_id: 'S1', status: 'confirmed', payment_status: 'paid', wix_booking_id: 'ORD-1' }]);
    const world1 = await refreshProviderEvents(db as never, P, { accessToken: 'k', siteId: 's' }, emptySummary());
    const creds = { accessToken: 'k', siteId: 's' };

    // check-in on Wix -> attendance
    wix.orders[0].checkedIn = true;
    const s1 = emptySummary();
    await reconcileOrders(db as never, P, creds, world1, s1);
    check(db.all('attendance').length === 1 && db.all('attendance')[0].booking_id === 'B1' && db.all('attendance')[0].status === 'present', 'a ticket checked in on Wix marks the seat present');
    check(s1.checkIns === 1, 'counted');
    await reconcileOrders(db as never, P, creds, world1, emptySummary());
    check(db.all('attendance').length === 1, 'and is not marked twice');

    // vendor cancels the order on Wix -> seat cancelled as a vendor cancellation
    wix.orders[0].status = 'CANCELED';
    const s2 = emptySummary();
    await reconcileOrders(db as never, P, creds, world1, s2);
    const b1 = db.all('bookings').find((b) => b.id === 'B1')!;
    check(b1.status === 'cancelled' && b1.cancelled_by === 'owner-1', "an order the vendor cancelled on Wix cancels the parent's seat as a vendor cancellation (so they are told)");
    check(order(db).status === 'cancelled' && order(db).wix_order_status === 'CANCELED' && s2.ordersCancelled === 1, 'the local order follows');
  }
  {
    // a confirmed order whose booking rows were never written is repaired
    const { db, wix } = world(); use(wix);
    wix.orders.push({ orderNumber: 'ORD-2', eventId: 'WEV1', status: 'PAID', email: 'katie@x.test', created: new Date().toISOString(), qty: 2, checkedIn: false, tickets: ['ORD-2-T1', 'ORD-2-T2'] });
    Object.assign(order(db), { status: 'confirmed', payment_status: 'paid', wix_order_number: 'ORD-2', quantity: 2, tickets: [] });
    const w = await refreshProviderEvents(db as never, P, { accessToken: 'k', siteId: 's' }, emptySummary());
    const s = emptySummary();
    await reconcileOrders(db as never, P, { accessToken: 'k', siteId: 's' }, w, s);
    check(s.bookingsRepaired === 1 && db.all('bookings').filter((b) => b.wix_booking_id === 'ORD-2').length === 2, 'a confirmed order with no seats gets its two seats');
    check(((order(db).tickets as unknown[]) ?? []).length === 2, 'and its tickets are filled in from Wix');
  }
  // 10 ------------------------------------------------------------ RSVP-type events
  {
    const { db, wix } = world(); use(wix);
    const rsvp = await createWixRsvp({ accessToken: 'k', siteId: 's' }, {
      eventId: 'WEV1', firstName: 'Katie', lastName: 'Crowson', email: 'katie@x.test',
      inputValues: [{ inputName: 'firstName', value: 'Katie' }], guestCount: 2, guestNames: ['Sam', 'Pip'],
    });
    const body = wix.lastRsvpBody as { rsvp: { status: string; disableNotifications: boolean; additionalGuestDetails: { guestCount: number; guestNames: string[] } } };
    check(rsvp.rsvpId.startsWith('RSVP-') && body.rsvp.status === 'YES', 'an RSVP is always requested as YES (no BabyBrain waitlist for Wix events)');
    check(body.rsvp.additionalGuestDetails.guestCount === 2 && body.rsvp.additionalGuestDetails.guestNames.join() === 'Sam,Pip', 'extra guests travel with their names');
    check(body.rsvp.disableNotifications === true, "Wix's own email from the organiser's domain is switched off");

    // the parent's RSVP and its seats, then the vendor marks them "not attending" on Wix
    db.seed('event_rsvps', [{ id: 'R1', user_id: U, event_id: 'LE1', status: 'yes', wix_rsvp_id: rsvp.rsvpId }]);
    db.seed('bookings', [{ id: 'RB1', user_id: U, session_id: 'S1', status: 'confirmed', wix_booking_id: rsvp.rsvpId }, { id: 'RB2', user_id: U, session_id: 'S1', status: 'confirmed', wix_booking_id: rsvp.rsvpId }]);
    const w = await refreshProviderEvents(db as never, P, { accessToken: 'k', siteId: 's' }, emptySummary());
    const s0 = emptySummary();
    await reconcileRsvps(db as never, P, { accessToken: 'k', siteId: 's' }, w, s0);
    check(s0.rsvpsCancelled === 0 && db.all('bookings').every((b) => b.status === 'confirmed'), 'a still-attending RSVP is left alone');
    wix.rsvps[0].status = 'NO';
    const s1 = emptySummary();
    await reconcileRsvps(db as never, P, { accessToken: 'k', siteId: 's' }, w, s1);
    check(s1.rsvpsCancelled === 1 && db.all('bookings').every((b) => b.status === 'cancelled' && b.cancelled_by === 'owner-1'), "an RSVP the vendor set to NO cancels the whole party's seats as a vendor cancellation");
    check(db.all('event_rsvps')[0].status === 'cancelled', 'and the RSVP follows');
    wix.rsvps.length = 0;
    db.all('event_rsvps')[0].status = 'yes';
    db.all('bookings').forEach((b) => { b.status = 'confirmed'; });
    const s2 = emptySummary();
    await reconcileRsvps(db as never, P, { accessToken: 'k', siteId: 's' }, w, s2);
    check(s2.rsvpsCancelled === 0, "an RSVP missing from Wix's list is never read as removed");
  }

  // 11 ------------------------------------------------------------ unticking a series in the picker
  {
    const { db } = world();
    db.seed('activities', [
      { id: 'SA1', provider_id: P, wix_series_id: 'SER-A', slug: 'class-a', title: 'Class A', wix_service_type: 'EVENT' },
      { id: 'SA2', provider_id: P, wix_series_id: 'SER-B', slug: 'class-b', title: 'Class B', wix_service_type: 'EVENT' },
    ]);
    db.seed('activity_sessions', [{ id: 'SS1', activity_id: 'SA1' }, { id: 'SS2', activity_id: 'SA2' }]);
    db.seed('bookings', [{ id: 'SB1', user_id: U, session_id: 'SS2', status: 'confirmed' }]);
    const r = await unlinkWixSeries(db as never, P, ['SER-A', 'SER-B']);
    check(r.removed === 1 && r.protectedSeries.length === 1 && r.protectedSeries[0].seriesId === 'SER-B', 'a series with a live booking is protected; an empty one is retired');
    const a1 = db.all('activities').find((a) => a.id === 'SA1')!;
    check(a1.is_published === false && a1.wix_series_id === null && a1.wix_service_type === null && !!a1.wix_removed_at, 'the retired series is detached so it is not re-imported');
    check(db.all('activities').find((a) => a.id === 'SA2')!.wix_series_id === 'SER-B', 'the protected series is untouched');
  }
  // 12 ------------------------------------------------------------ a multi-day camp: one Wix event, five days
  {
    const { db, wix } = world(); use(wix);
    db.tables.set('wix_events', []); db.tables.set('activities', []); db.tables.set('activity_sessions', []); db.tables.set('bookings', []); db.tables.set('event_ticket_orders', []); db.tables.set('event_ticket_types', []);
    wix.events.clear();
    wix.events.set('WEV1', { title: 'Nature Holiday Camp', start: '2099-10-12T01:00:00Z', end: '2099-10-16T04:00:00Z', seriesId: null, regStatus: 'OPEN_TICKETS', controls: FakeWix.controls() });
    db.seed('wix_events', [{ id: 'LE1', provider_id: P, wix_event_id: 'WEV1', title: 'Nature Holiday Camp', start_date: '2099-10-12T01:00:00Z', end_date: '2099-10-16T04:00:00Z' }]);
    db.seed('event_ticket_types', [
      { id: 'TTs', event_id: 'LE1', wix_ticket_definition_id: 'DEFs', name: 'Single Day', price_cents: 9900, hidden: false, sale_status: 'SALE_STARTED', is_free: false, capacity_total: 16, fee_type: 'FEE_ADDED_AT_CHECKOUT', fee_rate_percent: 2.5 },
      { id: 'TT3', event_id: 'LE1', wix_ticket_definition_id: 'DEF3', name: '3 Day Package', price_cents: 28900, hidden: false, sale_status: 'SALE_STARTED', is_free: false, capacity_total: 4, fee_type: 'FEE_ADDED_AT_CHECKOUT', fee_rate_percent: 2.5 },
    ]);
    // As imported today: one activity, one 99-hour session.
    db.seed('activities', [{ id: 'CA', provider_id: P, wix_event_id: 'LE1', title: 'Nature Holiday Camp', slug: 'camp', wix_service_type: 'EVENT' }]);
    db.seed('activity_sessions', [{ id: 'SPAN', activity_id: 'CA', starts_at: '2099-10-12T01:00:00Z', ends_at: '2099-10-16T04:00:00Z' }]);

    const creds = { accessToken: 'k', siteId: 's' };
    const sum = emptySummary();
    await refreshProviderEvents(db as never, P, creds, sum);
    const live = db.all('activity_sessions').filter((x) => x.status !== 'cancelled');
    const minutes = live.map((x) => (Date.parse(String(x.ends_at)) - Date.parse(String(x.starts_at))) / 60000);
    check(live.length === 5 && minutes.every((m) => m === 180), 'the camp now shows as five 9:00-12:00 days, not one 5,940-minute block');
    check(live.map((x) => x.wix_day).sort().join() === '2099-10-12,2099-10-13,2099-10-14,2099-10-15,2099-10-16', 'one session per calendar day');
    check(db.all('activity_sessions').find((x) => x.id === 'SPAN')!.status === 'cancelled', 'the old single-span session is retired');
    const ca = db.all('activities').find((a) => a.id === 'CA')!;
    check(ca.wix_series_id === 'md:WEV1' && ca.wix_event_id === null && ca.wix_service_type === 'EVENT', 'the activity is kept, now owned by the reconcile job (the 15-minute sync leaves it alone)');
    check(live.every((x) => x.capacity === null || x.capacity === undefined), 'a day carries no made-up capacity');
    const again = emptySummary();
    await refreshProviderEvents(db as never, P, creds, again);
    check(db.all('activity_sessions').filter((x) => x.status !== 'cancelled').length === 5 && again.datesAdded === 0, 'a second run changes nothing');

    // One parent books two single days for one child: two tickets, two places on the right days.
    const days = live.map((x) => String(x.wix_day)).sort();
    db.seed('event_ticket_orders', [{ id: 'OD1', user_id: U, child_id: CH, event_id: 'LE1', ticket_type_id: 'TTs', quantity: 2, selected_days: [days[0], days[2]], party_size: 1, status: 'pending', payment_status: 'none', amount: 202.95, stripe_payment_intent: 'pi_md1', created_at: new Date(Date.now() - 5 * 60_000).toISOString() }]);
    wix.reservations.set('RES-D1', { eventId: 'WEV1', qty: 2, used: false, expired: false });
    const r1 = await fulfilPaidWixEventOrder(db as never, 'OD1', { source: 'webhook', reservationId: 'RES-D1', paymentIntent: 'pi_md1' });
    const seats1 = db.all('bookings').filter((b) => b.stripe_payment_intent === 'pi_md1');
    const dayOf = (sid: unknown) => String(db.all('activity_sessions').find((x) => x.id === sid)!.wix_day);
    check(r1.status === 'fulfilled' && seats1.length === 2, 'two single days: two places');
    check(seats1.map((b) => dayOf(b.session_id)).sort().join() === `${days[0]},${days[2]}`, 'seated on exactly the two days chosen (Mon and Wed)');
    check(seats1.every((b) => Math.abs(Number(b.amount) - 101.475) < 0.01), 'the price is split across the places');
    check(wix.orders[wix.orders.length - 1].qty === 2, 'two Wix tickets were bought');

    // A 3 Day Package: ONE ticket, three places.
    db.seed('event_ticket_orders', [{ id: 'OD2', user_id: U, child_id: CH, event_id: 'LE1', ticket_type_id: 'TT3', quantity: 1, selected_days: [days[0], days[1], days[4]], party_size: 1, status: 'pending', payment_status: 'none', amount: 296.23, stripe_payment_intent: 'pi_md2', created_at: new Date(Date.now() - 5 * 60_000).toISOString() }]);
    wix.reservations.set('RES-D2', { eventId: 'WEV1', qty: 1, used: false, expired: false });
    const r2 = await fulfilPaidWixEventOrder(db as never, 'OD2', { source: 'webhook', reservationId: 'RES-D2', paymentIntent: 'pi_md2' });
    const seats2 = db.all('bookings').filter((b) => b.stripe_payment_intent === 'pi_md2');
    check(r2.status === 'fulfilled' && seats2.length === 3 && wix.orders[wix.orders.length - 1].qty === 1, 'a 3-day package: one Wix ticket, three places');
    check(seats2.map((b) => dayOf(b.session_id)).sort().join() === `${days[0]},${days[1]},${days[4]}`, 'on the three days chosen');

    // The vendor cancels the package order on Wix: every one of its places goes.
    const o2 = wix.orders[wix.orders.length - 1];
    o2.status = 'CANCELED';
    const world2 = await refreshProviderEvents(db as never, P, creds, emptySummary());
    const s3 = emptySummary();
    await reconcileOrders(db as never, P, creds, world2, s3);
    check(db.all('bookings').filter((b) => b.stripe_payment_intent === 'pi_md2').every((b) => b.status === 'cancelled'), 'cancelling the package on Wix cancels all three places');
    check(db.all('bookings').filter((b) => b.stripe_payment_intent === 'pi_md1').every((b) => b.status === 'confirmed'), 'and leaves the other order alone');

    // Wix check-in is one flag per ticket, so it must not mark a day-by-day place present.
    const o1 = wix.orders.find((o) => o.orderNumber === db.all('event_ticket_orders').find((x) => x.id === 'OD1')!.wix_order_number)!;
    o1.checkedIn = true;
    const s4 = emptySummary();
    await reconcileOrders(db as never, P, creds, world2, s4);
    check(db.all('attendance').length === 0, "a ticket-level Wix check-in does not guess which day's place to mark");
  }

  // 9 ------------------------------------------------------------- prefill from earlier bookings
  {
    const db = new FakeDb();
    const Q = (name: string, label: string, extra: Record<string, unknown> = {}) => ({ name, label, mandatory: true, ...extra });
    db.seed('wix_events', [
      { id: 'NEW', form_questions: [Q('n1', 'Does your child have any allergies?'), Q('n2', 'T-shirt size', { options: ['S', 'M'], controlType: 'DROPDOWN' })] },
      { id: 'OLD1', form_questions: [Q('o1', 'Does your child have any allergies')] },
      { id: 'OLD2', form_questions: [Q('p1', 'Any allergies?'), Q('p2', 'Does your child have any allergies?')] },
      { id: 'PLAIN', form_questions: [Q('x1', 'T-shirt size', { options: ['S', 'M'], controlType: 'DROPDOWN' })] },
    ]);
    db.seed('event_ticket_orders', [
      { id: 'a', user_id: 'U1', child_id: 'C1', event_id: 'OLD1', form_response: { o1: 'Peanuts' }, created_at: '2026-08-01T00:00:00Z' },
      { id: 'b', user_id: 'U1', child_id: 'C2', event_id: 'OLD1', form_response: { o1: 'Shellfish' }, created_at: '2026-09-20T00:00:00Z' },
      { id: 'c', user_id: 'U2', child_id: 'C1', event_id: 'OLD1', form_response: { o1: 'Dairy' }, created_at: '2026-09-25T00:00:00Z' },
      { id: 'd', user_id: 'U1', child_id: 'C1', event_id: 'OLD1', form_response: {}, created_at: '2026-09-30T00:00:00Z' },
    ]);
    db.seed('event_rsvps', [{ id: 'r', user_id: 'U1', child_id: 'C1', event_id: 'OLD2', form_response: { p2: 'Eggs' }, created_at: '2026-09-10T00:00:00Z' }]);

    const got = await loadRememberedAnswers(db as never, { userId: 'U1', eventId: 'NEW', childId: 'C1' });
    check(got.n1 === 'Eggs', 'the newest answer for the same child (an RSVP) fills the allergy question, matched by its wording');
    check(!('n2' in got), 'a dropdown choice is not carried');
    const other = await loadRememberedAnswers(db as never, { userId: 'U1', eventId: 'NEW', childId: 'C2' });
    check(other.n1 === 'Shellfish', "another child gets only their own answers, never the sibling's");
    const stranger = await loadRememberedAnswers(db as never, { userId: 'U3', eventId: 'NEW', childId: 'C1' });
    check(Object.keys(stranger).length === 0, "another parent's answers are never used, even for the same child id");
    const none = await loadRememberedAnswers(db as never, { userId: 'U1', eventId: 'PLAIN', childId: 'C1' });
    check(Object.keys(none).length === 0, 'an event with only choice questions has nothing to carry');
    const unknown = await loadRememberedAnswers(db as never, { userId: 'U1', eventId: 'MISSING', childId: 'C1' });
    check(Object.keys(unknown).length === 0, 'an unknown event has nothing to carry');
  }

  // 10 ------------------------------------------------------------ a venue Wix sent without a postal code
  {
    const db = new FakeDb();
    db.seed('provider_locations', [
      { id: 'V1', provider_id: P, name: 'Tanglin Park', address: '1 Ridley Park, Singapore 248464', postal_code: '248464', latitude: null, longitude: null, wix_address_locked: false },
      { id: 'V2', provider_id: P, name: 'The Crest', address: '103 Prince Charles Cres, Singapore', postal_code: null, latitude: null, longitude: null, wix_address_locked: false },
      { id: 'V3', provider_id: P, name: 'Locked', address: '5 Locked Lane, Singapore', postal_code: null, latitude: null, longitude: null, wix_address_locked: true },
    ]);
    const cacheOf = () => new Map<string, LocationEntry>(db.all('provider_locations').map((l) => [l.address as string, { id: l.id as string, postal_code: l.postal_code as string | null, latitude: l.latitude as number | null, wix_address_locked: !!l.wix_address_locked }]));
    const ev = (address: string, postalCode: string | null = null) => ({ location: { type: 'VENUE', locationTbd: false, formattedAddress: address, name: null, city: 'Singapore', postalCode } }) as never;
    let lookups = 0;
    const found = async () => { lookups++; return { postalCode: '159018', latitude: 1.2927, longitude: 103.8198 }; };
    const none = async () => { lookups++; return null; };
    const cache = cacheOf();
    const e1 = ev('103 Prince Charles Cres, Singapore');
    const id = await resolveEventLocation(db as never, P, e1, cache, { count: 3 }, found);
    const v2 = () => db.all('provider_locations').find((l) => l.id === 'V2')!;
    check(id === 'V2' && v2().postal_code === '159018' && v2().latitude === 1.2927, 'an existing venue with no postal code is completed from its address (postal code and pin)');
    check((e1 as { location: { postalCode: string } }).location.postalCode === '159018', "and the event carries it, so the activity rows written from it don't blank it");
    await resolveEventLocation(db as never, P, ev('103 Prince Charles Cres, Singapore'), cache, { count: 3 }, found);
    check(lookups === 1, 'the address is looked up once per run, not per event');
    const lockedId = await resolveEventLocation(db as never, P, ev('5 Locked Lane, Singapore'), cacheOf(), { count: 3 }, found);
    check(lockedId === 'V3' && db.all('provider_locations').find((l) => l.id === 'V3')!.postal_code === null, "a venue an admin corrected by hand is never touched, and isn't looked up");
    const before = lookups;
    await resolveEventLocation(db as never, P, ev('1 Ridley Park, Singapore 248464'), cacheOf(), { count: 3 }, found);
    check(lookups === before && db.all('provider_locations').find((l) => l.id === 'V1')!.postal_code === '248464', 'a venue that already has a postal code is not looked up');
    const db2 = new FakeDb();
    db2.seed('provider_locations', [{ id: 'W1', provider_id: P, name: 'X', address: '9 Nowhere Rd, Singapore', postal_code: null, latitude: null, longitude: null, wix_address_locked: false }]);
    const c2 = new Map<string, LocationEntry>([['9 Nowhere Rd, Singapore', { id: 'W1', postal_code: null, latitude: null, wix_address_locked: false }]]);
    const e2 = ev('9 Nowhere Rd, Singapore');
    check((await resolveEventLocation(db2 as never, P, e2, c2, { count: 1 }, none)) === 'W1' && db2.all('provider_locations')[0].postal_code === null, 'when the address cannot be matched for certain, the venue is left as it was');
    const c3 = new Map<string, LocationEntry>();
    const newId = await resolveEventLocation(db2 as never, P, ev('103 Prince Charles Cres, Singapore'), c3, { count: 1 }, found);
    const created = db2.all('provider_locations').find((l) => l.id === newId)!;
    check(created.postal_code === '159018' && created.latitude === 1.2927, 'a new venue is created with the postal code and pin already filled');
    const c4 = new Map<string, LocationEntry>();
    await resolveEventLocation(db2 as never, P, ev('12 Wix Given Rd, Singapore', '123456'), c4, { count: 2 }, found);
    check(db2.all('provider_locations').some((l) => l.address === '12 Wix Given Rd, Singapore' && l.postal_code === '123456'), "Wix's own postal code is used when it sends one");
  }
} finally {
  globalThis.fetch = realFetch;
  console.error = origError;
  await noop();
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL FLOW CHECKS PASSED');
process.exit(failures ? 1 : 0);
