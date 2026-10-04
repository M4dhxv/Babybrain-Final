import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { recordSale } from '@/lib/commercials';
import { sendOpsAlert, sendWixOrderFailureAlert } from '@/lib/payment-alert';
import {
  WixApiError,
  checkoutWixEventOrder,
  confirmWixEventOrder,
  createWixTicketReservation,
  fetchWixEvent,
  fetchWixOrders,
  getProviderWixCredentials,
  wixApplicationErrorCode,
  type WixCheckoutResult,
  type WixCredentials,
  type WixIssuedTicket,
} from './client';
import { resolveWixContact } from './sync';
import { resolveWixEventGuestForm } from './event-form';
import { notifyEventTicketPending } from './event-notify';
import { placePlan } from './event-days';

const wixErrorCode = wixApplicationErrorCode;

/** One line a person can act on: Wix's own error code when it gave one. */
export function describeFulfilmentError(e: unknown): string {
  if (e instanceof WixApiError) {
    const code = wixErrorCode(e);
    let description = '';
    try {
      description = (JSON.parse(e.body)?.message as string | undefined) ?? '';
    } catch {
      description = e.body.slice(0, 120);
    }
    return [code ?? `HTTP ${e.status}`, description && description !== code ? description : '', e.path].filter(Boolean).join(' — ');
  }
  return e instanceof Error ? e.message : String(e);
}

/** After this many failed attempts only a person can resolve the order. */
export const MAX_FULFILMENT_ATTEMPTS = 6;
/** Minutes to wait after attempt N (1-based) before the automatic retry. */
export const FULFILMENT_RETRY_BACKOFF_MINUTES = [10, 30, 120, 360, 1440];
/** Two callers working the same order within this window are treated as a race, not a retry. Long enough
 *  for a slow run (up to four Wix calls, each bounded at 20s) to finish, so a parent-return arriving
 *  late can't start a second attempt while the first is still creating the Wix order. Cron retries are
 *  10+ minutes apart, so this costs them nothing. */
export const CLAIM_WINDOW_MS = 180_000;

export type FulfilmentOutcome =
  | { status: 'fulfilled'; orderNumber: string; adopted: boolean }
  | { status: 'already'; orderNumber: string | null }
  /** Another caller is working this order right now. */
  | { status: 'busy' }
  /** Refunded, cancelled, unpaid or gone — nothing to fulfil. */
  | { status: 'not_payable' }
  | { status: 'failed'; error: string; attempts: number };

/** The issued tickets of one order, read back from Wix when the checkout /
 *  confirm response did not carry them (a FREE order comes back without). */
export async function issuedTicketsForOrder(
  creds: WixCredentials,
  eventId: string,
  orderNumber: string,
  known: WixIssuedTicket[] = []
): Promise<WixIssuedTicket[]> {
  if (known.length) return known;
  try {
    const orders = await fetchWixOrders(creds, { eventIds: [eventId], searchPhrase: orderNumber, maxOrders: 50 });
    return orders.find((o) => o.orderNumber === orderNumber)?.tickets ?? [];
  } catch (e) {
    console.error('[wix events] could not read the issued tickets back', orderNumber, e);
    return [];
  }
}

/** Only what must outlive the page: the number and the permanent QR target.
 *  The signed PDF / wallet links expire within a day, so they are fetched
 *  fresh on request instead (app/api/wix/events/ticket). */
export const storableTickets = (tickets: WixIssuedTicket[]) =>
  tickets.map((t) => ({ ticketNumber: t.ticketNumber, checkInUrl: t.checkInUrl }));

/**
 * Turns a PAID Stripe checkout for a Wix Events ticket into a real Wix order,
 * a BabyBrain booking per seat, and an earnings entry. Every entry point —
 * Stripe's webhook, the parent's return from Stripe, the background retry and
 * an admin's Retry button — runs this one function, so the rules live in one
 * place:
 *
 *  - Idempotent. An order that already has a Wix order number is done.
 *  - Race-safe. A claim on the row (attempt counter + timestamp) means the
 *    webhook and the parent-return call, or a cron tick and an admin click,
 *    cannot both create a Wix order for one payment.
 *  - Retry-safe. Retries make a *fresh* reservation (the original has long
 *    expired) — but first look in the vendor's Wix for an order this very
 *    buyer already has for this event, and adopt it rather than selling the
 *    seat twice.
 *  - Never silent. A failure records Wix's actual error on the order, and a
 *    person is emailed on the first failure and again when retries run out.
 *
 * Confirmed live against a real event that `options.markAsPaid` on Checkout
 * does NOT reliably move an order to PAID (see checkoutWixEventOrder), so a
 * Confirm Order call always follows for anything not FREE/PAID.
 *
 * A Wix reservation holds for as little as 20 minutes but Stripe Checkout
 * can't be made to expire sooner than 30, so a slow payer can return with
 * money taken and the hold gone — the fresh-reservation path covers that.
 */
export async function fulfilPaidWixEventOrder(
  admin: SupabaseClient<Database>,
  orderId: string,
  opts: {
    source: 'webhook' | 'retry';
    /** The reservation made at checkout. Only the first webhook attempt can still use it. */
    reservationId?: string | null;
    paymentIntent?: string | null;
  }
): Promise<FulfilmentOutcome> {
  const { data: row } = await admin
    .from('event_ticket_orders')
    .select(
      'id, user_id, child_id, event_id, ticket_type_id, quantity, amount, status, payment_status, wix_order_number, stripe_payment_intent, created_at, fulfilment_attempts, medical_disclosure, policies_accepted, info_response, form_response, selected_days, party_size'
    )
    .eq('id', orderId)
    .maybeSingle();
  if (!row) return { status: 'not_payable' };
  if (row.wix_order_number) return { status: 'already', orderNumber: row.wix_order_number };
  if (row.payment_status === 'refunded' || row.status === 'cancelled') return { status: 'not_payable' };
  // A retry only makes sense for money already collected. The webhook / return
  // from Stripe is itself the proof of payment, so those may proceed from 'none'.
  if (opts.source === 'retry' && row.payment_status !== 'paid') return { status: 'not_payable' };

  const attempts = row.fulfilment_attempts + 1;
  const paymentIntent = opts.paymentIntent ?? row.stripe_payment_intent ?? null;

  const claimCutoff = new Date(Date.now() - CLAIM_WINDOW_MS).toISOString();
  const { data: claimed } = await admin
    .from('event_ticket_orders')
    .update({
      fulfilment_attempts: attempts,
      fulfilment_last_attempt_at: new Date().toISOString(),
      ...(paymentIntent ? { stripe_payment_intent: paymentIntent } : {}),
    })
    .eq('id', row.id)
    .is('wix_order_number', null)
    .or(`fulfilment_last_attempt_at.is.null,fulfilment_last_attempt_at.lt.${claimCutoff}`)
    .select('id')
    .maybeSingle();
  if (!claimed) return { status: 'busy' };

  const { data: event } = await admin
    .from('wix_events')
    .select('provider_id, title, wix_event_id')
    .eq('id', row.event_id)
    .maybeSingle();
  const { data: ticketType } = await admin
    .from('event_ticket_types')
    .select('wix_ticket_definition_id')
    .eq('id', row.ticket_type_id)
    .maybeSingle();
  const creds = event?.provider_id ? await getProviderWixCredentials(admin, event.provider_id) : null;

  const fail = async (e: unknown, extra = ''): Promise<FulfilmentOutcome> => {
    const error = (describeFulfilmentError(e) + extra).slice(0, 500);
    console.error('[fulfilPaidWixEventOrder] could not create the Wix order', row.id, error);
    await admin
      .from('event_ticket_orders')
      .update({ payment_status: 'paid', stripe_payment_intent: paymentIntent, fulfilment_error: error })
      .eq('id', row.id);
    const gaveUp = attempts >= MAX_FULFILMENT_ATTEMPTS;
    // Tell the parent once, on the first failure: they have paid and have no ticket yet.
    if (attempts === 1) {
      const { data: org } = event?.provider_id
        ? await admin.from('providers').select('business_name').eq('id', event.provider_id).maybeSingle()
        : { data: null };
      await notifyEventTicketPending(admin, {
        userId: row.user_id,
        eventTitle: event?.title ?? null,
        providerName: org?.business_name ?? null,
        orderId: row.id,
      });
    }
    // Alert on the first failure (so a human knows today) and when retries run out.
    if (attempts === 1 || gaveUp) {
      const { data: buyer } = await admin.from('parent_profiles').select('email').eq('id', row.user_id).maybeSingle();
      await sendWixOrderFailureAlert({
        kind: 'event ticket',
        orderId: row.id,
        eventTitle: event?.title ?? null,
        providerId: event?.provider_id ?? 'unknown',
        customerEmail: buyer?.email ?? null,
        amount: row.amount,
        paymentIntent,
        reason: error,
        attempts,
        gaveUp,
      });
    }
    return { status: 'failed', error, attempts };
  };

  if (!event?.provider_id) return fail(new Error('the event has no provider'));
  if (!ticketType) return fail(new Error('the ticket type is gone'));
  if (!creds) return fail(new Error('the provider has no Wix credentials'));

  const contact = await resolveWixContact(admin, row.user_id);
  // The event's live form + registration: the form is what Wix validates the
  // order against, and `guestsAssignedSeparately` means one form per ticket.
  const liveEvent = await fetchWixEvent(creds, event.wix_event_id).catch(() => null);
  const guestForm = await resolveWixEventGuestForm(admin, creds, event.wix_event_id, {
    contact,
    childId: row.child_id,
    infoResponse: row.info_response,
    answers: row.form_response,
    inputs: liveEvent ? liveEvent.formInputs : undefined,
  });
  const guest = {
    ...contact,
    formInputs: guestForm.inputValues,
    guestCount: liveEvent?.registration?.guestsAssignedSeparately ? row.quantity : 1,
  };

  async function checkoutAndConfirm(resId: string): Promise<WixCheckoutResult & { tickets: WixIssuedTicket[] }> {
    const checkout = await checkoutWixEventOrder(creds!, { eventId: event!.wix_event_id, reservationId: resId, guest });
    if (checkout.status === 'PAID' || checkout.status === 'FREE') return { ...checkout, tickets: [] };
    try {
      const confirmed = await confirmWixEventOrder(creds!, event!.wix_event_id, checkout.orderNumber);
      return { ...checkout, status: confirmed.status, tickets: confirmed.tickets };
    } catch (e) {
      // ORDER_ACTION_NOT_AVAILABLE (428): already confirmed by a racing caller,
      // or cancelled/expired between checkout and confirm. checkout()'s own
      // result is the best info left.
      if (wixErrorCode(e) === 'ORDER_ACTION_NOT_AVAILABLE') return { ...checkout, tickets: [] };
      throw e;
    }
  }

  let result: (WixCheckoutResult & { tickets: WixIssuedTicket[] }) | null = null;
  let adopted = false;

  // Strategy A — the first webhook delivery can still use the reservation made at checkout.
  if (opts.source === 'webhook' && opts.reservationId && attempts === 1) {
    try {
      result = await checkoutAndConfirm(opts.reservationId);
    } catch (e) {
      const code = wixErrorCode(e);
      // This reservation already produced an order via another caller (webhook
      // + parent-return racing): whoever won will finish the row.
      if (code === 'RESERVATION_OCCUPIED') return { status: 'busy' };
      if (!(code === 'RESERVATION_NOT_FOUND' || (e instanceof WixApiError && e.status === 404))) return fail(e);
      // The hold lapsed while the parent was on Stripe — fall through to a fresh one.
    }
  }

  // Strategy B — a fresh reservation, after checking Wix didn't already take this order.
  if (!result) {
    try {
      const existing = await findAdoptableWixOrder(admin, creds, row, event.wix_event_id, contact.email);
      if (existing) {
        adopted = true;
        let status = existing.status;
        let tickets: WixIssuedTicket[] = existing.tickets;
        if (status !== 'PAID' && status !== 'FREE') {
          try {
            const confirmed = await confirmWixEventOrder(creds, event.wix_event_id, existing.orderNumber);
            status = confirmed.status;
            tickets = confirmed.tickets.length ? confirmed.tickets : tickets;
          } catch (e) {
            if (wixErrorCode(e) !== 'ORDER_ACTION_NOT_AVAILABLE') throw e;
          }
        }
        result = {
          orderNumber: existing.orderNumber,
          status,
          ticketsQuantity: existing.ticketsQuantity,
          totalPrice: existing.totalPrice,
          tickets,
        };
      } else {
        const fresh = await createWixTicketReservation(creds, ticketType.wix_ticket_definition_id, row.quantity);
        result = await checkoutAndConfirm(fresh.id);
      }
    } catch (e) {
      return fail(
        e,
        guestForm.missing.length
          ? ` — mandatory form field(s) with no value: ${guestForm.missing.map((m) => m.label || m.name).join(', ')}`
          : ''
      );
    }
  }

  const tickets = await issuedTicketsForOrder(creds, event.wix_event_id, result.orderNumber, result.tickets);
  await admin
    .from('event_ticket_orders')
    .update({
      status: 'confirmed',
      payment_status: 'paid',
      stripe_payment_intent: paymentIntent,
      wix_order_number: result.orderNumber,
      wix_order_status: result.status,
      wix_synced_at: new Date().toISOString(),
      tickets: storableTickets(tickets),
      fulfilment_error: null,
    })
    .eq('id', row.id);

  const mirrored = await mirrorEventTicketAsBookings(admin, {
    providerId: event.provider_id,
    localEventId: row.event_id,
    ticketTypeId: row.ticket_type_id,
    userId: row.user_id,
    childId: row.child_id,
    quantity: row.quantity,
    days: row.selected_days,
    partySize: row.party_size,
    totalAmount: row.amount,
    stripePaymentIntent: paymentIntent,
    wixOrderNumber: result.orderNumber,
    paymentStatus: 'paid',
    medicalDisclosure: row.medical_disclosure,
    policiesAccepted: row.policies_accepted,
    infoResponse: row.info_response,
  });

  // The ticket exists on Wix but no booking row was written (the mirrored
  // activity/session wasn't found): the parent would hold a ticket that never
  // appears in My Bookings or on the vendor's roster. The reconcile job repairs
  // this on its next pass; tell a person now so it isn't discovered by a complaint.
  if (!mirrored.firstBookingId) {
    await sendOpsAlert(`Wix event ticket issued but no booking recorded — ${event.title ?? 'event'}`, [
      'The Wix order was created, but BabyBrain could not write the booking (no mirrored activity or session for the event).',
      'The parent has a ticket that does not show in My Bookings. The reconcile job will retry; if it persists, check the event’s activity.',
      '',
      `Order   : ${row.id}  (Wix ${result.orderNumber})`,
      `Payment : ${paymentIntent ?? '—'}`,
    ]);
  }

  // A ticket sale is a sale: the vendor's Earnings ledger has to show it, same
  // as a class booking, or a payout has nothing to reconcile against. `amount`
  // is the whole order total, exactly what Stripe charged. Idempotent on the
  // payment intent, so any racing caller is safe.
  await recordSale(admin, {
    providerId: event.provider_id,
    source: 'booking',
    bookingId: mirrored.firstBookingId,
    grossCents: Math.round(Number(row.amount ?? 0) * 100),
    paymentIntentId: paymentIntent,
  });

  // The parent was charged `amount`; Wix says the order costs `totalPrice`. A
  // difference (tax, a price edited since the page loaded) is not fatal — the
  // ticket is issued — but it means vendor and parent disagree about the price.
  if (result.totalPrice && row.amount != null && Math.abs(result.totalPrice.value - Number(row.amount)) > 0.011) {
    await sendOpsAlert(`Wix event order total differs from what the parent paid — ${event.title ?? 'event'}`, [
      'A ticket was issued, but the order total on the vendor’s Wix differs from the amount charged on Stripe.',
      '',
      `Event    : ${event.title ?? '—'}`,
      `Order    : ${row.id}  (Wix ${result.orderNumber})`,
      `Charged  : ${Number(row.amount).toFixed(2)}`,
      `Wix says : ${result.totalPrice.value.toFixed(2)} ${result.totalPrice.currency}`,
      `Payment  : ${paymentIntent ?? '—'}`,
    ]);
  }

  return { status: 'fulfilled', orderNumber: result.orderNumber, adopted };
}

/** An order this buyer already has on the vendor's Wix for this event, made
 *  since this BabyBrain order was placed and not claimed by another local
 *  order — what a retry adopts instead of selling the seat a second time. */
async function findAdoptableWixOrder(
  admin: SupabaseClient<Database>,
  creds: WixCredentials,
  row: { event_id: string; quantity: number; created_at: string },
  wixEventId: string,
  email: string
) {
  if (!email) return null;
  const orders = await fetchWixOrders(creds, { eventIds: [wixEventId], searchPhrase: email, maxOrders: 400 });
  const { data: taken } = await admin
    .from('event_ticket_orders')
    .select('wix_order_number')
    .eq('event_id', row.event_id)
    .not('wix_order_number', 'is', null);
  const used = new Set((taken ?? []).map((t) => t.wix_order_number));
  const since = new Date(row.created_at).getTime() - 5 * 60_000;
  return (
    orders.find(
      (o) =>
        !used.has(o.orderNumber) &&
        !['CANCELED', 'DECLINED', 'VOIDED'].includes(o.status) &&
        o.ticketsQuantity === row.quantity &&
        (o.email ?? '').toLowerCase() === email.toLowerCase() &&
        !!o.created &&
        Date.parse(o.created) >= since
    ) ?? null
  );
}

/**
 * Stripe confirmed payment for a Wix Events ticket — called from the webhook
 * (`checkout.session.completed`) and /api/stripe/reconcile. See
 * {@link fulfilPaidWixEventOrder} for the rules.
 */
export async function finalizeWixEventTicketCheckout(
  admin: SupabaseClient<Database>,
  session: Pick<Stripe.Checkout.Session, 'metadata' | 'payment_intent'>
): Promise<FulfilmentOutcome | null> {
  const orderId = session.metadata?.order_id;
  if (!orderId) return null;
  const paymentIntent =
    typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id ?? null;
  return fulfilPaidWixEventOrder(admin, orderId, {
    source: 'webhook',
    reservationId: session.metadata?.wix_reservation_id ?? null,
    paymentIntent,
  });
}

/**
 * The `activity_sessions` row a Wix event's bookings hang off. The date's own session
 * first: a recurring series is one activity with a session per date, each stamped with its
 * Wix event (activity_sessions.wix_event_id, 00221). Older single-event activities are found
 * through activities.wix_event_id instead. Null (and logged) when neither exists.
 */
export async function findEventSessionId(
  admin: SupabaseClient<Database>,
  providerId: string,
  localEventId: string
): Promise<string | null> {
  const { data: stamped } = await admin
    .from('activity_sessions')
    .select('id')
    .eq('wix_event_id', localEventId)
    .neq('status', 'cancelled')
    .order('starts_at', { ascending: true })
    .limit(1);
  if (stamped?.[0]) return stamped[0].id;

  const { data: activity } = await admin
    .from('activities')
    .select('id')
    .eq('provider_id', providerId)
    .eq('wix_event_id', localEventId)
    .maybeSingle();
  if (!activity) {
    console.error('[findEventSessionId] no mirrored activity found — the booking list will miss this purchase', localEventId);
    return null;
  }
  // A Wix event has exactly one occurrence, so its activity carries exactly one session — but
  // `.maybeSingle()` resolves to an *error* the moment two rows match, and this activity has
  // duplicated its session row for real before now (see syncEventActivityMirror's own note, and
  // scripts/dedupe-wix-event-sessions.mjs). That turned a paid ticket into one that never
  // appeared in My Bookings at all. Take the earliest row instead.
  const { data: sessions } = await admin
    .from('activity_sessions')
    .select('id')
    .eq('activity_id', activity.id)
    .order('starts_at', { ascending: true })
    .limit(1);
  if (!sessions?.[0]) {
    console.error('[findEventSessionId] mirrored activity has no session row', activity.id);
    return null;
  }
  return sessions[0].id;
}

/**
 * Writes one `bookings` row per ticket purchased — display-only, the
 * authoritative record stays `event_ticket_orders` above. Exists purely so
 * "My Bookings" and the vendor roster, which both read `bookings`, show a
 * Wix Events ticket purchase without either of them needing to know Events
 * exist as a separate concept. Mirrors the exact one-row-per-seat shape
 * app/api/wix/bookings/route.ts already uses for Wix Bookings.
 *
 * Best-effort: if the mirrored activity/session somehow isn't there (sync
 * hasn't run since this event was first linked — shouldn't happen in
 * practice since checkout requires a synced ticket type to begin with), the
 * real order above is already saved either way, so this logs and returns
 * rather than throwing back into the webhook/reconcile caller.
 *
 * Returns the first row it wrote, so the caller can hang an earnings ledger
 * entry off it — null when nothing was written, which recordSale accepts
 * (the sale is still recorded, just not linked to a booking row).
 */
export async function mirrorEventTicketAsBookings(
  admin: SupabaseClient<Database>,
  params: {
    providerId: string;
    localEventId: string;
    ticketTypeId: string;
    userId: string;
    childId: string | null;
    quantity: number;
    /** Multi-day events: the days booked (YYYY-MM-DD) and the number of children - a place is seated for each child on each day. */
    days?: string[] | null;
    partySize?: number | null;
    totalAmount: number | null;
    stripePaymentIntent: string | null;
    wixOrderNumber: string;
    /** 'none' for a free RSVP, 'paid' once Stripe has actually collected money. */
    paymentStatus: 'none' | 'paid';
    /** Parent medical & health disclosure, when the event's activity asks for one. */
    medicalDisclosure?: string | null;
    /** Provider policy ids the parent ticked — the booking_policy_record trigger fans these out. */
    policiesAccepted?: string[] | null;
    /** Parent answer to the activity's info-request prompt, when it has one. */
    infoResponse?: string | null;
  }
): Promise<{ firstBookingId: string | null }> {
  // Idempotent on the Wix order: a retry, or a webhook racing a return from
  // Stripe, must never write a second set of seats for the same order.
  const { data: already } = await admin
    .from('bookings')
    .select('id')
    .eq('user_id', params.userId)
    .eq('wix_booking_id', params.wixOrderNumber)
    .limit(1);
  if (already?.length) return { firstBookingId: already[0].id };

  // A day-by-day booking is seated on the session of each day chosen - one place per child per day - so the
  // vendor's roster for a given day lists exactly who is coming that day. Otherwise it is one place per ticket
  // on the event's single session.
  let placeSessions: string[];
  if (params.days?.length) {
    const { data: daySessions } = await admin
      .from('activity_sessions')
      .select('id, wix_day')
      .eq('wix_event_id', params.localEventId)
      .in('wix_day', params.days)
      .neq('status', 'cancelled');
    const idByDay = new Map((daySessions ?? []).map((d) => [d.wix_day as string, d.id]));
    placeSessions = placePlan(params.partySize ?? params.quantity, params.days)
      .map((p) => idByDay.get(p.day))
      .filter((id): id is string => !!id);
    if (placeSessions.length === 0) {
      console.error('[mirrorEventTicketAsBookings] none of the booked days has a session', params.localEventId, params.days);
      return { firstBookingId: null };
    }
  } else {
    const eventSessionId = await findEventSessionId(admin, params.providerId, params.localEventId);
    if (!eventSessionId) return { firstBookingId: null };
    placeSessions = Array.from({ length: params.quantity }, () => eventSessionId);
  }

  const perSeat = params.totalAmount != null ? params.totalAmount / placeSessions.length : null;
  const rows = placeSessions.map((sessionId) => ({
    user_id: params.userId,
    child_id: params.childId,
    session_id: sessionId,
    status: 'confirmed' as const,
    payment_status: params.paymentStatus,
    amount: perSeat,
    stripe_payment_intent: params.stripePaymentIntent,
    wix_booking_id: params.wixOrderNumber,
    wix_ticket_type_id: params.ticketTypeId,
    medical_disclosure: params.medicalDisclosure ?? null,
    policies_accepted: params.policiesAccepted ?? [],
    info_response: params.infoResponse ?? null,
  }));
  const { data: inserted, error } = await admin.from('bookings').insert(rows).select('id');
  if (error) console.error('[mirrorEventTicketAsBookings] insert failed', error);
  return { firstBookingId: inserted?.[0]?.id ?? null };
}
