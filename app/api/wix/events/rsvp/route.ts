import { NextResponse } from 'next/server';
import { getAuthedContext } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  WixApiError,
  checkoutWixEventOrder,
  confirmWixEventOrder,
  createWixTicketReservation,
  fetchWixEvent,
  fetchWixTicketDefinitions,
  getProviderWixCredentials,
  wixApplicationErrorCode,
} from '@/lib/wix/client';
import { evaluateWixEvent, evaluateWixTicket, parentBlockerMessage } from '@/lib/wix/event-eligibility';
import { resolveWixContact } from '@/lib/wix/sync';
import { resolveDaySelection } from '@/lib/wix/event-day-booking';
import {
  wixFormProblemBody,
  resolveWixEventGuestForm,
  sanitiseWixFormAnswers,
  validateWixFormAnswers,
  wixFormMissingParentMessage,
} from '@/lib/wix/event-form';
import { issuedTicketsForOrder, mirrorEventTicketAsBookings, storableTickets } from '@/lib/wix/finalize-event-checkout';

const wixErrorCode = wixApplicationErrorCode;

/**
 * Parent RSVPs to a free Wix Events ticket — no payment, so the reservation
 * → checkout → (confirm if needed) round trip happens synchronously in one
 * request instead of being split around a Stripe redirect like the paid
 * path in app/api/wix/events/checkout.
 * Body: { eventId, ticketTypeId, childId?, medicalDisclosure?, policiesAccepted?, infoResponse? }
 */
// Every Wix API call is bounded at 20s by wixFetch, and these routes make
// several of them back to back (resolve a slot, create the booking, confirm
// it). On the platform default (~10s) a slow-but-healthy Wix response gets
// the function killed mid-flight and the user sees a bare network error —
// for credentials/bookings that were perfectly fine. Same 60s ceiling the
// other Wix routes already set.
export const maxDuration = 60;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    eventId?: string;
    ticketTypeId?: string;
    childId?: string | null;
    /** Multi-day events: the days chosen (YYYY-MM-DD). */
    days?: string[];
    medicalDisclosure?: string;
    policiesAccepted?: string[];
    infoResponse?: string;
    formAnswers?: unknown;
  };
  const { eventId, ticketTypeId } = body;
  if (!eventId || !ticketTypeId) {
    return NextResponse.json({ error: 'eventId and ticketTypeId required' }, { status: 400 });
  }

  const { user } = await getAuthedContext(request);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const admin = createAdminClient();
  const { data: ticketType } = await admin
    .from('event_ticket_types')
    .select('id, event_id, wix_ticket_definition_id, name, is_free, hidden, sold_out')
    .eq('id', ticketTypeId)
    .maybeSingle();
  if (!ticketType || ticketType.event_id !== eventId || ticketType.hidden) {
    return NextResponse.json({ error: 'Ticket type not found' }, { status: 404 });
  }
  if (!ticketType.is_free) {
    return NextResponse.json({ error: 'This ticket requires payment — use checkout, not RSVP' }, { status: 400 });
  }
  // Friendly stop before hitting Wix — the live reservation below is still the
  // authority, but a synced sold-out flag saves the round trip. Wix Events
  // have no BabyBrain waitlist (00107).
  if (ticketType.sold_out) {
    return NextResponse.json({ error: 'This ticket is sold out' }, { status: 409 });
  }

  const { data: event } = await admin
    .from('wix_events')
    .select('id, provider_id, wix_event_id, is_published, wix_removed_at')
    .eq('id', eventId)
    .maybeSingle();
  if (!event || !event.is_published || event.wix_removed_at) {
    return NextResponse.json({ error: 'Event not found' }, { status: 404 });
  }

  const creds = await getProviderWixCredentials(admin, event.provider_id);
  if (!creds) {
    return NextResponse.json({ error: 'This business has not connected a Wix account' }, { status: 409 });
  }

  // Same pre-flight as events/checkout: stop before holding a seat when Wix
  // would refuse the order (registration closed / paused, members only, sales
  // not open, a form field we can't fill).
  const [liveEvent, liveTickets] = await Promise.all([
    fetchWixEvent(creds, event.wix_event_id).catch(() => undefined),
    fetchWixTicketDefinitions(creds, event.wix_event_id, { seating: true }).catch(() => undefined),
  ]);
  if (liveEvent === null) {
    return NextResponse.json({ error: 'This event is no longer available.' }, { status: 404 });
  }
  const liveTicket = liveTickets?.find((t) => t.id === ticketType.wix_ticket_definition_id);
  if (liveTickets && !liveTicket) {
    return NextResponse.json({ error: 'That ticket type is no longer available' }, { status: 409 });
  }
  const blockers = [...(liveEvent ? evaluateWixEvent(liveEvent) : []), ...(liveTicket ? evaluateWixTicket(liveTicket) : [])];
  if (blockers.length) {
    return NextResponse.json({ error: parentBlockerMessage(blockers), code: blockers[0].code }, { status: 409 });
  }

  const contact = await resolveWixContact(admin, user.id);
  const answers = liveEvent ? sanitiseWixFormAnswers(liveEvent.formInputs, body.formAnswers) : {};
  if (liveEvent) {
    const problems = validateWixFormAnswers(liveEvent.formInputs, answers, { fallbackAnswer: !!body.infoResponse?.trim() });
    if (problems.length) {
      return NextResponse.json(wixFormProblemBody(liveEvent.formInputs, problems), { status: 422 });
    }
  }
  const guestForm = await resolveWixEventGuestForm(admin, creds, event.wix_event_id, {
    contact,
    childId: body.childId ?? null,
    infoResponse: body.infoResponse ?? null,
    answers,
    inputs: liveEvent ? liveEvent.formInputs : undefined,
  });
  if (guestForm.missing.length) {
    console.error('[wix events rsvp] form needs fields we cannot fill', event.wix_event_id, guestForm.missing.map((m) => m.label || m.name));
    return NextResponse.json({ error: wixFormMissingParentMessage(guestForm.missing, false) }, { status: 409 });
  }

  // A multi-day event is booked by day (see lib/wix/event-days.ts): a free single-day ticket is one per day.
  const daySel = await resolveDaySelection(admin, {
    localEventId: event.id,
    ticketName: ticketType.name,
    partySize: 1,
    days: body.days,
    ticketLimitPerOrder: liveEvent?.registration?.ticketLimitPerOrder ?? 20,
  });
  if (daySel.multiDay && 'error' in daySel) {
    return NextResponse.json({ error: daySel.error }, { status: 422 });
  }
  const dayPlan = daySel.multiDay && 'plan' in daySel ? daySel : null;
  const quantity = dayPlan ? dayPlan.plan.tickets : 1;

  let reservation;
  try {
    reservation = await createWixTicketReservation(creds, ticketType.wix_ticket_definition_id, quantity);
  } catch (e) {
    if (e instanceof WixApiError && (e.status === 404 || e.status === 400)) {
      return NextResponse.json({ error: 'That ticket type is no longer available' }, { status: 409 });
    }
    console.error('Could not create Wix ticket reservation', e);
    return NextResponse.json({ error: 'Could not reach Wix — try again' }, { status: 502 });
  }

  let checkout;
  try {
    checkout = await checkoutWixEventOrder(creds, { eventId: event.wix_event_id, reservationId: reservation.id, guest: { ...contact, formInputs: guestForm.inputValues } });
    // FREE tickets are expected to come back already confirmed; anything
    // else (confirmed live: even markAsPaid doesn't reliably do this — see
    // checkoutWixEventOrder) needs an explicit Confirm Order call.
    if (checkout.status !== 'FREE' && checkout.status !== 'PAID') {
      try {
        const confirmed = await confirmWixEventOrder(creds, event.wix_event_id, checkout.orderNumber);
        checkout = { ...checkout, status: confirmed.status };
      } catch (e) {
        if (wixErrorCode(e) !== 'ORDER_ACTION_NOT_AVAILABLE') throw e;
      }
    }
  } catch (e) {
    console.error('Could not check out a free Wix event ticket', e);
    return NextResponse.json({ error: 'Could not reach Wix — try again' }, { status: 502 });
  }

  const { data: order, error: insertErr } = await admin
    .from('event_ticket_orders')
    .insert({
      user_id: user.id,
      child_id: body.childId ?? null,
      event_id: event.id,
      ticket_type_id: ticketType.id,
      quantity,
      selected_days: dayPlan?.days ?? [],
      party_size: dayPlan?.plan.partySize ?? null,
      status: 'confirmed',
      payment_status: 'none',
      amount: 0,
      wix_reservation_id: reservation.id,
      wix_order_number: checkout.orderNumber,
      wix_order_status: checkout.status,
      wix_synced_at: new Date().toISOString(),
      tickets: storableTickets(await issuedTicketsForOrder(creds, event.wix_event_id, checkout.orderNumber)),
      medical_disclosure: body.medicalDisclosure?.trim() || null,
      policies_accepted: body.policiesAccepted ?? [],
      info_response: body.infoResponse?.trim() || null,
      form_response: answers,
    })
    .select('id, status')
    .single();
  if (insertErr || !order) {
    console.error('RSVP’d in Wix but failed to save the local order', checkout.orderNumber, insertErr);
    return NextResponse.json({ error: 'RSVP’d in Wix but failed to save locally — contact support' }, { status: 500 });
  }

  // Display-only mirror so this shows up in "My Bookings" — see
  // mirrorEventTicketAsBookings's own comment for why this exists
  // alongside event_ticket_orders rather than instead of it.
  await mirrorEventTicketAsBookings(admin, {
    providerId: event.provider_id,
    localEventId: event.id,
    ticketTypeId: ticketType.id,
    userId: user.id,
    childId: body.childId ?? null,
    quantity,
    days: dayPlan?.days ?? [],
    partySize: dayPlan?.plan.partySize ?? null,
    totalAmount: 0,
    stripePaymentIntent: null,
    wixOrderNumber: checkout.orderNumber,
    paymentStatus: 'none',
    medicalDisclosure: body.medicalDisclosure?.trim() || null,
    policiesAccepted: body.policiesAccepted ?? [],
    infoResponse: body.infoResponse?.trim() || null,
  });

  return NextResponse.json(order);
}
