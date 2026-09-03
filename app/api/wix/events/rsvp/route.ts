import { NextResponse } from 'next/server';
import { getAuthedContext } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { WixApiError, checkoutWixEventOrder, confirmWixEventOrder, createWixTicketReservation, getProviderWixCredentials } from '@/lib/wix/client';
import { resolveWixContact } from '@/lib/wix/sync';
import { mirrorEventTicketAsBookings } from '@/lib/wix/finalize-event-checkout';

function wixErrorCode(e: unknown): string | null {
  if (!(e instanceof WixApiError)) return null;
  try {
    return (JSON.parse(e.body)?.details?.applicationError?.code as string | undefined) ?? null;
  } catch {
    return null;
  }
}

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
    medicalDisclosure?: string;
    policiesAccepted?: string[];
    infoResponse?: string;
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
    .select('id, event_id, wix_ticket_definition_id, is_free, hidden')
    .eq('id', ticketTypeId)
    .maybeSingle();
  if (!ticketType || ticketType.event_id !== eventId || ticketType.hidden) {
    return NextResponse.json({ error: 'Ticket type not found' }, { status: 404 });
  }
  if (!ticketType.is_free) {
    return NextResponse.json({ error: 'This ticket requires payment — use checkout, not RSVP' }, { status: 400 });
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

  let reservation;
  try {
    reservation = await createWixTicketReservation(creds, ticketType.wix_ticket_definition_id, 1);
  } catch (e) {
    if (e instanceof WixApiError && (e.status === 404 || e.status === 400)) {
      return NextResponse.json({ error: 'That ticket type is no longer available' }, { status: 409 });
    }
    console.error('Could not create Wix ticket reservation', e);
    return NextResponse.json({ error: 'Could not reach Wix — try again' }, { status: 502 });
  }

  const contact = await resolveWixContact(admin, user.id);
  let checkout;
  try {
    checkout = await checkoutWixEventOrder(creds, { eventId: event.wix_event_id, reservationId: reservation.id, guest: contact });
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
      quantity: 1,
      status: 'confirmed',
      payment_status: 'none',
      amount: 0,
      wix_reservation_id: reservation.id,
      wix_order_number: checkout.orderNumber,
      medical_disclosure: body.medicalDisclosure?.trim() || null,
      policies_accepted: body.policiesAccepted ?? [],
      info_response: body.infoResponse?.trim() || null,
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
    quantity: 1,
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
