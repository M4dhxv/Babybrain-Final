import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, WixFormQuestion } from '@/types/database';
import { createAdminClient } from '@/lib/supabase/admin';
import { getStripe } from '@/lib/stripe';
import { sendOpsAlert } from '@/lib/payment-alert';
import {
  fetchWixEvents,
  fetchWixOrders,
  fetchWixRsvps,
  getProviderWixCredentials,
  type WixCredentials,
  type WixEvent,
  type WixOrderSnapshot,
} from './client';
import {
  evaluateWixEvent,
  evaluateWixTicket,
  type WixEventBlocker,
} from './event-eligibility';
import { formAllowsAdditionalGuests, questionsForParent } from './event-form';
import { applySeriesPlan, planSeries, type SeriesOccurrence } from './events-series';
import { splitMultiDay } from './event-days';
import {
  FULFILMENT_RETRY_BACKOFF_MINUTES,
  MAX_FULFILMENT_ATTEMPTS,
  fulfilPaidWixEventOrder,
  mirrorEventTicketAsBookings,
  storableTickets,
} from './finalize-event-checkout';
import { healEarningsFromStripe, recordSale } from '@/lib/commercials';

/**
 * Keeps BabyBrain's picture of Wix Events honest between syncs. The vendor's
 * Wix account is the source of truth for an event's registration state and for
 * what happens to an order after we create it, but Wix webhooks need an
 * installed Wix app and a vendor connects with an API key — so this polls.
 *
 * Per provider, each run:
 *  1. Event health — can each mirrored event take a booking right now
 *     (registration closed / paused, members only, tax added at checkout, a
 *     mandatory form field we can't answer)? Written to the activity so the
 *     parent page can say so up front and the vendor sees what to change.
 *  2. Orders — read each active event's orders back from Wix and apply what the
 *     vendor did there: a cancelled / declined order cancels the parent's seats
 *     (as a vendor cancellation, so they're told and compensated), a ticket
 *     checked in on Wix marks the seat present.
 *  3. Retry — a paid order that Wix refused is retried with backoff (the vendor
 *     may well have fixed the cause), adopting an order Wix already holds
 *     rather than selling the seat twice.
 *
 * One implementation, run on Vercel by pg_cron (migration 00219). The Deno copy
 * of the sync is deliberately not involved.
 */

export interface WixEventsReconcileSummary {
  providers: number;
  eventsChecked: number;
  healthUpdated: number;
  ordersChecked: number;
  ordersUpdated: number;
  ordersCancelled: number;
  rsvpsCancelled: number;
  checkIns: number;
  /** Confirmed orders that had no booking rows and were repaired. */
  bookingsRepaired: number;
  /** Recurring series turned into one activity / earlier per-date activities folded in. */
  seriesConverted: number;
  seriesMerged: number;
  datesAdded: number;
  datesCancelled: number;
  retried: number;
  retryFulfilled: number;
  /** Paid orders whose Stripe webhook never arrived, found by searching Stripe. */
  lostPaymentsFound: number;
  /** Earnings rows recorded without Stripe's facts, corrected from the charge. */
  earningsHealed: number;
  errors: string[];
  at: string;
}

type Admin = SupabaseClient<Database>;

const CANCELLED_ON_WIX = ['CANCELED', 'DECLINED', 'VOIDED'];
/** Look at events that haven't finished more than this long ago — a check-in or
 *  a late cancel can still arrive shortly after an event ends. */
const ORDER_WATCH_GRACE_MS = 3 * 86_400_000;
/** A paid order no one has fixed after this long stops being retried automatically. */
const RETRY_WINDOW_MS = 14 * 86_400_000;
/** Whole-run budget — the route has a 60s ceiling. */
const RUN_BUDGET_MS = 50_000;

export const emptySummary = (): WixEventsReconcileSummary => ({
  providers: 0,
  eventsChecked: 0,
  healthUpdated: 0,
  ordersChecked: 0,
  ordersUpdated: 0,
  ordersCancelled: 0,
  rsvpsCancelled: 0,
  checkIns: 0,
  bookingsRepaired: 0,
  seriesConverted: 0,
  seriesMerged: 0,
  datesAdded: 0,
  datesCancelled: 0,
  retried: 0,
  retryFulfilled: 0,
  lostPaymentsFound: 0,
  earningsHealed: 0,
  errors: [],
  at: new Date().toISOString(),
});

export async function runWixEventsReconcile(): Promise<WixEventsReconcileSummary> {
  const admin = createAdminClient();
  const summary = emptySummary();
  const started = Date.now();

  const { data: credRows } = await admin.from('provider_wix_credentials').select('provider_id');
  const providerIds = [...new Set((credRows ?? []).map((r) => r.provider_id))];

  // Least recently looked-at first, so a slow provider can't starve the rest across runs.
  const { data: lastSeen } = providerIds.length
    ? await admin.from('activities').select('provider_id, wix_event_checked_at').in('provider_id', providerIds).or('wix_event_id.not.is.null,wix_series_id.not.is.null')
    : { data: [] };
  const lastByProvider = new Map<string, number>();
  for (const r of lastSeen ?? []) {
    const t = r.wix_event_checked_at ? Date.parse(r.wix_event_checked_at) : 0;
    lastByProvider.set(r.provider_id as string, Math.min(lastByProvider.get(r.provider_id as string) ?? Infinity, t));
  }
  providerIds.sort((a, b) => (lastByProvider.get(a) ?? 0) - (lastByProvider.get(b) ?? 0));

  try {
    summary.earningsHealed = await healEarningsFromStripe(admin);
  } catch (e) {
    summary.errors.push(`earnings heal: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    await sweepLostPayments(admin, summary);
  } catch (e) {
    summary.errors.push(`lost-payment sweep: ${e instanceof Error ? e.message : String(e)}`);
  }

  for (const providerId of providerIds) {
    if (Date.now() - started > RUN_BUDGET_MS) break;
    try {
      const creds = await getProviderWixCredentials(admin, providerId);
      if (!creds) continue;
      const did = await reconcileProvider(admin, providerId, creds, summary, started);
      if (did) summary.providers++;
    } catch (e) {
      summary.errors.push(`${providerId}: ${e instanceof Error ? e.message : String(e)}`);
      console.error('[reconcile-wix-events] provider failed', providerId, e);
    }
  }
  return summary;
}

async function reconcileProvider(
  admin: Admin,
  providerId: string,
  creds: WixCredentials,
  summary: WixEventsReconcileSummary,
  runStarted: number
): Promise<boolean> {
  const { data: eventActivities } = await admin
    .from('activities')
    .select('id')
    .eq('provider_id', providerId)
    .is('wix_removed_at', null)
    .or('wix_event_id.not.is.null,wix_series_id.not.is.null')
    .limit(1);
  const { data: unfulfilled } = await admin
    .from('event_ticket_orders')
    .select('id, event_id, created_at, fulfilment_attempts, fulfilment_last_attempt_at, wix_events!inner(provider_id)')
    .eq('status', 'pending')
    .eq('payment_status', 'paid')
    .eq('wix_events.provider_id', providerId)
    .lt('fulfilment_attempts', MAX_FULFILMENT_ATTEMPTS)
    .gt('created_at', new Date(Date.now() - RETRY_WINDOW_MS).toISOString());

  if (!(eventActivities ?? []).length && !(unfulfilled ?? []).length) return false;

  // --- event metadata, series, per-date health, then orders: all from one read of the account's events ---
  if ((eventActivities ?? []).length) {
    const world = await refreshProviderEvents(admin, providerId, creds, summary);
    await reconcileOrders(admin, providerId, creds, world, summary);
    await reconcileRsvps(admin, providerId, creds, world, summary).catch((e) =>
      console.error('[reconcile-wix-events] RSVP reconcile failed (API key may lack the RSVP scope)', providerId, e)
    );
  }

  // --- retry paid-but-unfulfilled orders whose backoff has elapsed ---
  for (const o of unfulfilled ?? []) {
    if (Date.now() - runStarted > RUN_BUDGET_MS) break;
    const waitMin = FULFILMENT_RETRY_BACKOFF_MINUTES[Math.min(o.fulfilment_attempts - 1, FULFILMENT_RETRY_BACKOFF_MINUTES.length - 1)] ?? 0;
    const last = o.fulfilment_last_attempt_at ? Date.parse(o.fulfilment_last_attempt_at) : 0;
    if (o.fulfilment_attempts > 0 && Date.now() - last < waitMin * 60_000) continue;
    summary.retried++;
    const outcome = await fulfilPaidWixEventOrder(admin, o.id, { source: 'retry' });
    if (outcome.status === 'fulfilled' || outcome.status === 'already') summary.retryFulfilled++;
  }
  return true;
}

export interface LocalEventRow {
  id: string;
  wix_event_id: string;
  end_date: string | null;
  wix_missing_since: string | null;
  wix_series_id: string | null;
  recurrence_status: string | null;
  registration_type: string;
  registration_status: string | null;
  external_url: string | null;
  rsvp_limit: number | null;
  rsvp_waitlist: boolean;
  rsvp_allows_guests: boolean;
  form_questions: WixFormQuestion[];
  booking_blockers: WixEventBlocker[];
}

export interface ProviderEventsWorld {
  wixEvents: WixEvent[];
  localRows: LocalEventRow[];
}

/**
 * Brings BabyBrain's picture of a provider's Wix events up to date, in this order:
 *  1. each event's registration / series metadata, copied onto its wix_events row;
 *  2. recurring series folded into one activity with a session per date (events-series);
 *  3. per-date health: can this date take a booking, and what does a parent have to answer.
 *
 * Run by the reconcile job, and straight after a vendor imports or syncs events
 * from the portal so the vendor and parents see the real state immediately
 * instead of on the next 10-minute tick.
 */
export async function refreshProviderEvents(
  admin: Admin,
  providerId: string,
  creds: WixCredentials,
  summary: WixEventsReconcileSummary = emptySummary()
): Promise<ProviderEventsWorld> {
  const wixEvents = await fetchWixEvents(creds, 365);
  const wixById = new Map<string, WixEvent>(wixEvents.map((e) => [e.id, e]));

  const { data: rows } = await admin
    .from('wix_events')
    .select(
      'id, wix_event_id, end_date, wix_missing_since, wix_series_id, recurrence_status, registration_type, registration_status, external_url, rsvp_limit, rsvp_waitlist, rsvp_allows_guests, form_questions, booking_blockers'
    )
    .eq('provider_id', providerId);
  const localRows: LocalEventRow[] = (rows ?? []) as LocalEventRow[];
  const wixIdByLocal = new Map(localRows.map((r) => [r.id, r.wix_event_id]));

  // ---- 1. metadata ----
  const metaWrites: (() => PromiseLike<unknown>)[] = [];
  for (const row of localRows) {
    const live = wixById.get(row.wix_event_id);
    if (!live) continue;
    const reg = live.registration;
    // A multi-day event (one Wix event, Mon 9:00 -> Fri 12:00) is decoded into one session per day by the
    // same machinery as a recurring series, under a key of its own. Sticky: once split, it stays under that
    // key even if the vendor later shortens it to one day, so the days are cleaned up rather than orphaned.
    const multiDayKey = `md:${live.id}`;
    const seriesKey =
      live.recurrence.seriesId ?? (splitMultiDay(live) || row.wix_series_id === multiDayKey ? multiDayKey : null);
    const desired = {
      wix_series_id: seriesKey,
      recurrence_status: live.recurrence.status,
      registration_type: reg?.type ?? 'TICKETING',
      registration_status: reg?.status ?? null,
      external_url: reg?.externalUrl ?? null,
      rsvp_limit: reg?.rsvp?.limit ?? null,
      rsvp_waitlist: reg?.rsvp?.waitlistEnabled ?? false,
      rsvp_allows_guests: formAllowsAdditionalGuests(live.formInputs),
    };
    const changed = (Object.keys(desired) as (keyof typeof desired)[]).some((k) => desired[k] !== row[k]);
    if (changed) {
      metaWrites.push(() => admin.from('wix_events').update(desired).eq('id', row.id));
      Object.assign(row, desired);
    }
  }
  // A first run after deploy changes every event: write them together, not one at a time.
  for (let i = 0; i < metaWrites.length; i += 15) await Promise.all(metaWrites.slice(i, i + 15).map((w) => w()));

  // Ticket types of every local event (hidden / sale window / price / capacity).
  const allLocalIds = localRows.map((r) => r.id);
  const { data: ticketRows } = allLocalIds.length
    ? await admin
        .from('event_ticket_types')
        .select('event_id, hidden, sale_status, is_free, price_cents, capacity_total, fee_type, fee_rate_percent')
        .in('event_id', allLocalIds)
    : { data: [] };
  const ticketsByEvent = new Map<string, { hidden: boolean; saleStatus: string; free: boolean; pricingType: string | null }[]>();
  const ticketTypes = new Map<
    string,
    { price_cents: number; capacity_total: number | null; fee_type: string | null; fee_rate_percent: number | null }[]
  >();
  for (const t of ticketRows ?? []) {
    const list = ticketsByEvent.get(t.event_id) ?? [];
    list.push({
      hidden: t.hidden,
      saleStatus: t.sale_status,
      free: t.is_free,
      // A paid ticket with no fixed price is a donation ticket (Wix lets the guest name the amount).
      pricingType: !t.is_free && t.price_cents === 0 ? 'DONATION' : 'STANDARD',
    });
    ticketsByEvent.set(t.event_id, list);
    if (!t.hidden) {
      const tt = ticketTypes.get(t.event_id) ?? [];
      tt.push({ price_cents: t.price_cents, capacity_total: t.capacity_total, fee_type: t.fee_type, fee_rate_percent: t.fee_rate_percent });
      ticketTypes.set(t.event_id, tt);
    }
  }

  // ---- 2. series ----
  await consolidateSeries(admin, providerId, wixEvents, localRows, ticketTypes, summary);

  // ---- 3. per-date health, then the activity's own summary ----
  const { data: activities } = await admin
    .from('activities')
    .select(
      'id, wix_event_id, wix_series_id, wix_event_blockers, wix_form_extra_fields, wix_registration_type, external_booking_url'
    )
    .eq('provider_id', providerId)
    .is('wix_removed_at', null)
    .or('wix_event_id.not.is.null,wix_series_id.not.is.null');
  const seriesActivityIds = (activities ?? []).filter((a) => a.wix_series_id).map((a) => a.id);
  const { data: seriesSessions } = seriesActivityIds.length
    ? await admin
        .from('activity_sessions')
        .select('activity_id, wix_event_id, starts_at')
        .in('activity_id', seriesActivityIds)
        .neq('status', 'cancelled')
        .gte('starts_at', new Date().toISOString())
        .order('starts_at', { ascending: true })
    : { data: [] };

  const healthByLocal = new Map<string, { blockers: WixEventBlocker[]; questions: WixFormQuestion[]; live: WixEvent }>();
  for (const row of localRows) {
    const live = wixById.get(row.wix_event_id);
    if (!live) continue;
    summary.eventsChecked++;
    const blockers: WixEventBlocker[] = evaluateWixEvent(live);
    const tickets = live.registration?.type === 'TICKETING' || !live.registration ? ticketsByEvent.get(row.id) ?? [] : [];
    if (!blockers.length && tickets.length) {
      const perTicket = tickets.map((t) => evaluateWixTicket(t));
      if (perTicket.every((b) => b.length > 0)) blockers.push(...perTicket[0]);
    }
    // The questions the parent is asked on the booking page, copied from the vendor's own Wix
    // form (the parent app can't read Wix, and can't run this server-side classification).
    const questions = questionsForParent(live.formInputs) as WixFormQuestion[];
    healthByLocal.set(row.id, { blockers, questions, live });
    if (
      JSON.stringify(blockers) !== JSON.stringify(row.booking_blockers ?? []) ||
      JSON.stringify(questions) !== JSON.stringify(row.form_questions ?? [])
    ) {
      await admin.from('wix_events').update({ booking_blockers: blockers, form_questions: questions }).eq('id', row.id);
      Object.assign(row, { booking_blockers: blockers, form_questions: questions });
    }
  }

  const stampOnly: string[] = [];
  for (const a of activities ?? []) {
    // The dates this activity offers: its one event, or a series' upcoming dates.
    const localIds = a.wix_series_id
      ? [...new Set((seriesSessions ?? []).filter((s) => s.activity_id === a.id).map((s) => s.wix_event_id).filter((x): x is string => !!x))]
      : a.wix_event_id
        ? [a.wix_event_id]
        : [];
    const known = localIds.map((id) => healthByLocal.get(id)).filter((h): h is NonNullable<typeof h> => !!h);
    if (!known.length) {
      // Nothing live to judge (all past, or Wix no longer lists it) — still stamp it: this stamp is also the
      // job's heartbeat (Admin → Needs attention warns when it goes stale).
      stampOnly.push(a.id);
      continue;
    }

    // Bookable if ANY date is; otherwise the first date's reasons explain why not.
    const open = known.find((h) => h.blockers.length === 0);
    const blockers = open ? [] : known[0].blockers;
    const labels = [...new Set(known.flatMap((h) => h.questions.filter((q) => q.mandatory).map((q) => q.label || q.name)))];
    const next = (open ?? known[0]).live;
    const regType = next.registration?.type ?? 'TICKETING';
    const external = regType === 'EXTERNAL' ? next.registration?.externalUrl ?? null : null;

    const patch: Database['public']['Tables']['activities']['Update'] = { wix_event_checked_at: new Date().toISOString() };
    if (JSON.stringify(blockers) !== JSON.stringify(a.wix_event_blockers ?? [])) patch.wix_event_blockers = blockers;
    if (JSON.stringify(labels) !== JSON.stringify(a.wix_form_extra_fields ?? [])) patch.wix_form_extra_fields = labels;
    if (regType !== a.wix_registration_type) patch.wix_registration_type = regType;
    // An EXTERNAL event sends the parent to the organiser's own site (the existing "book on the
    // provider's site" path); stop doing so if it stops being external.
    if (external && external !== a.external_booking_url) patch.external_booking_url = external;
    if (!external && a.wix_registration_type === 'EXTERNAL' && a.external_booking_url) patch.external_booking_url = null;
    if (Object.keys(patch).length > 1) {
      summary.healthUpdated++;
      await admin.from('activities').update(patch).eq('id', a.id);
    } else {
      stampOnly.push(a.id); // nothing changed: only the heartbeat stamp, written together below
    }
  }
  if (stampOnly.length) {
    await admin.from('activities').update({ wix_event_checked_at: new Date().toISOString() }).in('id', stampOnly);
  }

  return { wixEvents, localRows };
}

/** Folds a provider's recurring series into one activity each (see events-series). */
async function consolidateSeries(
  admin: Admin,
  providerId: string,
  wixEvents: WixEvent[],
  localRows: LocalEventRow[],
  ticketTypes: Map<string, { price_cents: number; capacity_total: number | null; fee_type: string | null; fee_rate_percent: number | null }[]>,
  summary: WixEventsReconcileSummary
) {
  const localByWix = new Map(localRows.map((r) => [r.wix_event_id, r]));
  const occurrencesBySeries = new Map<string, SeriesOccurrence[]>();
  for (const e of wixEvents) {
    const local = localByWix.get(e.id);
    // The key stored on the event row: Wix's recurring-series id, or `md:<event id>` for a multi-day event.
    const seriesId = local?.wix_series_id;
    if (!seriesId || !local) continue;
    if (e.status !== 'UPCOMING' && e.status !== 'STARTED') continue;
    const list = occurrencesBySeries.get(seriesId) ?? [];
    const days = splitMultiDay(e);
    if (days) {
      for (const d of days) list.push({ localEventId: local.id, wixEventId: e.id, startDate: d.startDate, endDate: d.endDate, day: d.day });
    } else {
      list.push({ localEventId: local.id, wixEventId: e.id, startDate: e.startDate, endDate: e.endDate });
    }
    occurrencesBySeries.set(seriesId, list);
  }
  const localEventIdsBySeries = new Map<string, Set<string>>();
  for (const r of localRows) {
    if (!r.wix_series_id) continue;
    const set = localEventIdsBySeries.get(r.wix_series_id) ?? new Set<string>();
    set.add(r.id);
    localEventIdsBySeries.set(r.wix_series_id, set);
  }
  if (!localEventIdsBySeries.size) return;
  const goneLocalEventIds = new Set(localRows.filter((r) => r.wix_missing_since).map((r) => r.id));

  const { data: acts } = await admin
    .from('activities')
    .select('id, wix_event_id, wix_series_id, is_published, created_at')
    .eq('provider_id', providerId)
    .is('wix_removed_at', null)
    .or('wix_event_id.not.is.null,wix_series_id.not.is.null');
  const actIds = (acts ?? []).map((a) => a.id);
  if (!actIds.length) return;
  const { data: sess } = await admin
    .from('activity_sessions')
    .select('id, activity_id, wix_event_id, status, starts_at, ends_at, wix_day')
    .in('activity_id', actIds);
  const sessionIds = (sess ?? []).map((s) => s.id);
  const { data: booked } = sessionIds.length
    ? await admin.from('bookings').select('session_id').in('session_id', sessionIds).in('status', ['pending', 'confirmed', 'waitlisted'])
    : { data: [] };
  const bookedBySession = new Map<string, number>();
  for (const b of booked ?? []) bookedBySession.set(b.session_id, (bookedBySession.get(b.session_id) ?? 0) + 1);

  const plans = planSeries({
    occurrencesBySeries,
    localEventIdsBySeries,
    goneLocalEventIds,
    activities: (acts ?? []).map((a) => ({
      id: a.id,
      wixEventId: a.wix_event_id,
      wixSeriesId: a.wix_series_id,
      isPublished: a.is_published,
      createdAt: a.created_at,
      liveBookings: (sess ?? []).filter((s) => s.activity_id === a.id).reduce((n, s) => n + (bookedBySession.get(s.id) ?? 0), 0),
    })),
    sessions: (sess ?? []).map((s) => ({
      id: s.id,
      activityId: s.activity_id,
      wixEventId: s.wix_event_id,
      status: s.status,
      startsAt: s.starts_at,
      endsAt: s.ends_at,
      wixDay: s.wix_day,
    })),
  });

  const ctx = {
    providerId,
    wixEventsById: new Map(wixEvents.map((e) => [e.id, e])),
    wixIdByLocal: new Map(localRows.map((r) => [r.id, r.wix_event_id])),
    ticketTypes,
  };
  for (const plan of plans) {
    const r = await applySeriesPlan(admin, plan, ctx);
    summary.seriesConverted += r.converted;
    summary.seriesMerged += r.merged;
    summary.datesAdded += r.sessionsCreated;
    summary.datesCancelled += r.sessionsCancelled;
  }
}

/** Reads the vendor's Wix orders back and applies what happened there, and repairs
 *  confirmed orders that lost their seats. */
export async function reconcileOrders(
  admin: Admin,
  providerId: string,
  creds: WixCredentials,
  world: ProviderEventsWorld,
  summary: WixEventsReconcileSummary
) {
  const { localRows } = world;
  const wixIdByLocal = new Map(localRows.map((r) => [r.id, r.wix_event_id]));
  const watchSince = new Date(Date.now() - ORDER_WATCH_GRACE_MS).toISOString();
  const watchedLocal = localRows.filter((e) => !e.end_date || e.end_date >= watchSince).map((e) => e.id);
  if (!watchedLocal.length) return;
  const { data: localOrders } = await admin
    .from('event_ticket_orders')
    .select(
      'id, user_id, event_id, ticket_type_id, child_id, quantity, selected_days, party_size, status, payment_status, wix_order_number, wix_order_status, tickets, amount, stripe_payment_intent, medical_disclosure, policies_accepted, info_response'
    )
    .in('event_id', watchedLocal)
    .not('wix_order_number', 'is', null)
    .neq('status', 'cancelled');
  if (!(localOrders ?? []).length) return;

  // A confirmed order should always have its seats. If the booking write failed
  // when the order was created (no mirrored activity at that moment), write them
  // now — the mirror is idempotent on the Wix order number.
  const orderNumbers = (localOrders ?? []).map((o) => o.wix_order_number as string);
  const { data: seated } = await admin.from('bookings').select('wix_booking_id').in('wix_booking_id', orderNumbers);
  const seatedNumbers = new Set((seated ?? []).map((b) => b.wix_booking_id));
  for (const o of localOrders ?? []) {
    if (o.status !== 'confirmed' || seatedNumbers.has(o.wix_order_number)) continue;
    const mirroredSeats = await mirrorEventTicketAsBookings(admin, {
      providerId,
      localEventId: o.event_id,
      ticketTypeId: o.ticket_type_id,
      userId: o.user_id,
      childId: o.child_id,
      quantity: o.quantity,
      days: o.selected_days,
      partySize: o.party_size,
      totalAmount: o.amount,
      stripePaymentIntent: o.stripe_payment_intent,
      wixOrderNumber: o.wix_order_number as string,
      paymentStatus: o.payment_status === 'paid' ? 'paid' : 'none',
      medicalDisclosure: o.medical_disclosure,
      policiesAccepted: o.policies_accepted,
      infoResponse: o.info_response,
    });
    if (mirroredSeats.firstBookingId) {
      summary.bookingsRepaired++;
      if (o.payment_status === 'paid' && o.stripe_payment_intent) {
        await recordSale(admin, {
          providerId,
          source: 'booking',
          bookingId: mirroredSeats.firstBookingId,
          grossCents: Math.round(Number(o.amount ?? 0) * 100),
          paymentIntentId: o.stripe_payment_intent,
        });
      }
    }
  }

  const wixEventIds = [...new Set(watchedLocal.map((id) => wixIdByLocal.get(id)).filter((x): x is string => !!x))];
  const snapshots = new Map<string, WixOrderSnapshot>();
  for (let i = 0; i < wixEventIds.length; i += 100) {
    for (const o of await fetchWixOrders(creds, { eventIds: wixEventIds.slice(i, i + 100) })) snapshots.set(o.orderNumber, o);
  }

  for (const order of localOrders ?? []) {
    const snap = snapshots.get(order.wix_order_number as string);
    summary.ordersChecked++;
    if (!snap) continue; // not listed (archived, or Wix hiccup) — never act on absence

    const update: Database['public']['Tables']['event_ticket_orders']['Update'] = {};
    if (snap.status !== order.wix_order_status) update.wix_order_status = snap.status;
    const ticketsNow = storableTickets(snap.tickets);
    if (ticketsNow.length && JSON.stringify(ticketsNow) !== JSON.stringify(order.tickets)) update.tickets = ticketsNow;

    if (CANCELLED_ON_WIX.includes(snap.status)) {
      await cancelSeatsCancelledOnWix(admin, providerId, order, snap);
      update.status = 'cancelled';
      summary.ordersCancelled++;
    } else if (!(order.selected_days ?? []).length) {
      // A Wix check-in is one flag per ticket, not per day, so for a day-by-day booking it can't say which
      // day's place to mark - those are left for the vendor to mark on the roster.
      summary.checkIns += await markCheckedIn(admin, order, snap);
    }

    if (Object.keys(update).length) {
      update.wix_synced_at = new Date().toISOString();
      await admin.from('event_ticket_orders').update(update).eq('id', order.id);
      summary.ordersUpdated++;
    }
  }
}

/** The vendor cancelled / declined the order on their Wix. The parent's seats
 *  are cancelled as a *vendor* cancellation — the same path a cancelled Wix
 *  class takes (cancel_wix_session, 00146) — so they get the branded email and,
 *  if they paid, the make-up token (compensate_cancelled_booking). */
async function cancelSeatsCancelledOnWix(
  admin: Admin,
  providerId: string,
  order: { id: string; user_id: string; wix_order_number: string | null; payment_status: string; amount: number | null },
  snap: WixOrderSnapshot
) {
  const { data: provider } = await admin.from('providers').select('owner_id, business_name').eq('id', providerId).maybeSingle();
  const actor = provider?.owner_id ?? '00000000-0000-0000-0000-000000000000';
  await admin
    .from('bookings')
    .update({
      status: 'cancelled',
      cancel_refund_mode: 'refund',
      cancel_reason: 'Ticket cancelled by the provider on Wix',
      cancelled_by: actor,
    })
    .eq('user_id', order.user_id)
    .eq('wix_booking_id', order.wix_order_number as string)
    .in('status', ['pending', 'confirmed', 'waitlisted']);

  await sendOpsAlert(`Wix event ticket cancelled by the vendor — ${provider?.business_name ?? 'vendor'}`, [
    `The vendor cancelled order ${order.wix_order_number} on their Wix (status ${snap.status}).`,
    'BabyBrain cancelled the parent’s seats and, since they paid, issued a make-up token. If they should instead get their money back, refund the payment in Stripe.',
    '',
    `Order   : ${order.id}  (event_ticket_orders)`,
    `Paid    : ${order.payment_status === 'paid' ? `yes${order.amount != null ? ` (${Number(order.amount).toFixed(2)})` : ''}` : 'no'}`,
  ]);
}

/** Tickets the vendor checked in on Wix become attendance for the matching seat.
 *  Seats and tickets pair by sorted order (both are created together, one per
 *  ticket, and neither is individually addressable on the other side). */
async function markCheckedIn(
  admin: Admin,
  order: { user_id: string; wix_order_number: string | null },
  snap: WixOrderSnapshot
): Promise<number> {
  const checkedIn = [...snap.tickets].sort((a, b) => a.ticketNumber.localeCompare(b.ticketNumber));
  if (!checkedIn.some((t) => t.checkedInAt)) return 0;
  const { data: seats } = await admin
    .from('bookings')
    .select('id, session_id')
    .eq('user_id', order.user_id)
    .eq('wix_booking_id', order.wix_order_number as string)
    .neq('status', 'cancelled')
    .order('id', { ascending: true });
  if (!(seats ?? []).length) return 0;

  const seatIds = (seats ?? []).map((s) => s.id);
  const { data: existing } = await admin.from('attendance').select('booking_id').in('booking_id', seatIds);
  const done = new Set((existing ?? []).map((a) => a.booking_id));

  let marked = 0;
  for (let i = 0; i < Math.min(checkedIn.length, seats!.length); i++) {
    const at = checkedIn[i].checkedInAt;
    const seat = seats![i];
    if (!at || done.has(seat.id)) continue;
    const { error } = await admin
      .from('attendance')
      .insert({ booking_id: seat.id, session_id: seat.session_id, status: 'present', note: 'Checked in on Wix' });
    if (!error) marked++;
  }
  return marked;
}

/**
 * A pending, unpaid-looking ticket order that is well past its Stripe session's 30-minute life may still
 * have been *paid*: the webhook can fail to land (it has a history of that), and the parent-return fallback
 * only runs if they come back to the site. Nothing else would ever notice, and the parent would hold a
 * receipt and no ticket. So read the recent Checkout Sessions from Stripe - one paged list per run, newest
 * first, stopping once past the oldest candidate - and fulfil any paid one whose order is still waiting.
 * (Abandoned checkouts are common and linger, so this must not cost a Stripe call per order per run.)
 */
async function sweepLostPayments(admin: Admin, summary: WixEventsReconcileSummary) {
  const { data: stale } = await admin
    .from('event_ticket_orders')
    .select('id, created_at')
    .eq('status', 'pending')
    .eq('payment_status', 'none')
    .lt('created_at', new Date(Date.now() - 40 * 60_000).toISOString())
    .gt('created_at', new Date(Date.now() - 3 * 86_400_000).toISOString())
    .limit(500);
  if (!(stale ?? []).length) return;
  const waiting = new Set((stale ?? []).map((o) => o.id));
  const oldestMs = Math.min(...(stale ?? []).map((o) => Date.parse(o.created_at)));

  const stripe = getStripe();
  let scanned = 0;
  for await (const session of stripe.checkout.sessions.list({ created: { gte: Math.floor(oldestMs / 1000) - 600 }, limit: 100 })) {
    if (++scanned > 1000) break;
    const orderId = session.metadata?.order_id;
    if (session.metadata?.kind !== 'wix_event_ticket' || !orderId || !waiting.has(orderId) || session.payment_status !== 'paid') continue;
    summary.lostPaymentsFound++;
    console.error('[reconcile-wix-events] found a paid ticket order whose webhook never landed', orderId, session.id);
    const paymentIntent = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id ?? null;
    await fulfilPaidWixEventOrder(admin, orderId, { source: 'webhook', paymentIntent });
  }
}

/**
 * Bring one provider's Wix events up to date right now — metadata, recurring series
 * folded into one activity, and per-date booking health. Called after a vendor
 * imports or syncs events from the portal so the publish gate, the series and the
 * parent page reflect Wix immediately instead of after the next 10-minute tick.
 */
export async function refreshWixEventHealth(admin: Admin, providerId: string, creds: WixCredentials): Promise<void> {
  await refreshProviderEvents(admin, providerId, creds);
}

/** A vendor who marks a guest "not attending" on their Wix RSVP list (or whose guest is moved to NO)
 *  frees the seat there; mirror that here as a vendor cancellation so the parent is told. Only an
 *  explicit NO counts — an RSVP missing from the list is never read as removed. */
export async function reconcileRsvps(
  admin: Admin,
  providerId: string,
  creds: WixCredentials,
  world: ProviderEventsWorld,
  summary: WixEventsReconcileSummary
) {
  const localIds = world.localRows.map((r) => r.id);
  if (!localIds.length) return;
  const { data: live } = await admin
    .from('event_rsvps')
    .select('id, user_id, event_id, wix_rsvp_id')
    .in('event_id', localIds)
    .eq('status', 'yes')
    .not('wix_rsvp_id', 'is', null);
  if (!(live ?? []).length) return;

  const wixEventIds = [...new Set((live ?? []).map((r) => world.localRows.find((l) => l.id === r.event_id)?.wix_event_id).filter((x): x is string => !!x))];
  const remote = new Map<string, string>();
  for (let i = 0; i < wixEventIds.length; i += 100) {
    for (const r of await fetchWixRsvps(creds, wixEventIds.slice(i, i + 100))) remote.set(r.id, r.status);
  }

  const { data: provider } = await admin.from('providers').select('owner_id').eq('id', providerId).maybeSingle();
  const actor = provider?.owner_id ?? '00000000-0000-0000-0000-000000000000';
  for (const r of live ?? []) {
    if (remote.get(r.wix_rsvp_id as string) !== 'NO') continue;
    await admin
      .from('bookings')
      .update({
        status: 'cancelled',
        cancel_refund_mode: 'refund',
        cancel_reason: 'RSVP removed by the provider on Wix',
        cancelled_by: actor,
      })
      .eq('user_id', r.user_id)
      .eq('wix_booking_id', r.wix_rsvp_id as string)
      .in('status', ['pending', 'confirmed', 'waitlisted']);
    await admin.from('event_rsvps').update({ status: 'cancelled' }).eq('id', r.id);
    summary.rsvpsCancelled++;
  }
}
