import { NextResponse } from 'next/server';
import { getAuthedContext } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { appOrigin } from '@/lib/cors';
import { getStripe, DEFAULT_COMMISSION_RATE } from '@/lib/stripe';
import {
  WixApiError,
  computeWixCheckoutTotal,
  createWixTicketReservation,
  getProviderWixCredentials,
} from '@/lib/wix/client';

/**
 * Parent pays for a Wix Events ticket. Mirrors /api/wix/bookings/checkout's
 * deferral pattern: the real Wix order is only ever created (see
 * finalizeWixEventTicketCheckout) once Stripe confirms payment, so an
 * abandoned checkout never leaves a real order on the vendor's Wix Events
 * dashboard — just an expired Wix reservation that releases itself.
 *
 * Unlike Bookings, the *reservation* itself is created here, live, as the
 * authoritative availability check (Wix Events has no local capacity mirror
 * to re-check against — see 00069_wix_events.sql). The charge amount comes
 * from that reservation's own line items via computeWixCheckoutTotal, not
 * from event_ticket_types.price_cents alone, because Wix can add its own
 * service fee at checkout on top of the ticket price.
 * Body: { eventId, ticketTypeId, quantity?, childId? }
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    eventId?: string;
    ticketTypeId?: string;
    quantity?: number;
    childId?: string | null;
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
    .select('id, event_id, wix_ticket_definition_id, name, is_free, hidden, limit_per_checkout')
    .eq('id', ticketTypeId)
    .maybeSingle();
  if (!ticketType || ticketType.event_id !== eventId || ticketType.hidden) {
    return NextResponse.json({ error: 'Ticket type not found' }, { status: 404 });
  }
  if (ticketType.is_free) {
    return NextResponse.json({ error: 'This ticket is free — use the RSVP endpoint, not checkout' }, { status: 400 });
  }

  const { data: event } = await admin
    .from('wix_events')
    .select('id, provider_id, wix_event_id, title, slug, is_published, wix_removed_at')
    .eq('id', eventId)
    .maybeSingle();
  if (!event || !event.is_published || event.wix_removed_at) {
    return NextResponse.json({ error: 'Event not found' }, { status: 404 });
  }

  const creds = await getProviderWixCredentials(admin, event.provider_id);
  if (!creds) {
    return NextResponse.json({ error: 'This business has not connected a Wix account' }, { status: 409 });
  }

  const cap = ticketType.limit_per_checkout && ticketType.limit_per_checkout > 0 ? ticketType.limit_per_checkout : 20;
  const quantity = Math.min(Math.max(Math.trunc(body.quantity ?? 1), 1), Math.min(cap, 20));

  // The live, authoritative availability check — Wix's own reservation
  // system is the only source of truth for remaining capacity (no local
  // mirror to double-check against the way activity_sessions has for
  // Bookings' capacity trigger).
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

  const charge = computeWixCheckoutTotal(reservation.lines);
  if (!charge.value || charge.value <= 0) {
    return NextResponse.json({ error: 'This ticket is free — use the RSVP endpoint, not checkout' }, { status: 400 });
  }

  // Nothing else expires an abandoned pending order — not the Stripe webhook
  // (it has no checkout.session.expired handler enabled), not a cron — so a
  // skipped payment used to block this ticket type for the user indefinitely
  // ("still showing the same error hours later"). After 30 minutes both the
  // Stripe session and the Wix reservation are dead, so clear any stale
  // pending/unpaid row for this user + ticket type before starting a fresh one.
  await admin
    .from('event_ticket_orders')
    .delete()
    .eq('user_id', user.id)
    .eq('ticket_type_id', ticketType.id)
    .eq('status', 'pending')
    .eq('payment_status', 'none')
    .lt('created_at', new Date(Date.now() - 30 * 60 * 1000).toISOString());

  const { data: pending, error: insertErr } = await admin
    .from('event_ticket_orders')
    .insert({
      user_id: user.id,
      child_id: body.childId ?? null,
      event_id: event.id,
      ticket_type_id: ticketType.id,
      quantity,
      status: 'pending',
      payment_status: 'none',
      amount: charge.value,
      wix_reservation_id: reservation.id,
    })
    .select('id')
    .single();
  if (insertErr || !pending) {
    // Unique partial index (user_id, ticket_type_id) where pending+unpaid —
    // a double-submit or a second tab hits this, not a server error.
    if (insertErr?.code === '23505') {
      return NextResponse.json(
        { error: 'You already have a checkout in progress for this ticket — finish it or wait a few minutes for it to expire' },
        { status: 409 }
      );
    }
    console.error('Could not save pending Wix event ticket order', insertErr);
    return NextResponse.json({ error: 'Could not start payment — contact support' }, { status: 500 });
  }

  const origin = appOrigin(request);
  const title = event.title ?? 'Event ticket';

  const params = {
    mode: 'payment' as const,
    payment_method_types: ['paynow', 'card', 'grabpay'] as import('stripe').default.Checkout.SessionCreateParams.PaymentMethodType[],
    line_items: [
      {
        price_data: {
          currency: charge.currency.toLowerCase(),
          unit_amount: Math.round(charge.value * 100),
          product_data: { name: `${title} — ${ticketType.name} × ${quantity}` },
        },
        quantity: 1,
      },
    ],
    // Wix's own reservation hold is as short as 20 minutes (event-configured)
    // — shorter than Stripe's own 30-minute floor for expires_at, so a very
    // short hold can still lapse mid-checkout. Setting Stripe's minimum here
    // tightens the window as much as Stripe allows; finalizeWixEventTicketCheckout
    // covers the remaining gap with a fresh-reservation retry.
    expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
    metadata: {
      kind: 'wix_event_ticket',
      order_id: pending.id,
      event_id: event.id,
      wix_event_id: event.wix_event_id,
      ticket_type_id: ticketType.id,
      wix_reservation_id: reservation.id,
    },
    success_url: `${origin}/booked?title=${encodeURIComponent(title)}&slug=${encodeURIComponent(event.slug ?? '')}&status=confirmed&paid=1&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/profile?tab=bookings&booking=cancelled`,
  };

  let connect = {};
  const { data: provider } = await admin
    .from('providers')
    .select('stripe_account_id, payouts_enabled')
    .eq('id', event.provider_id)
    .maybeSingle();
  if (provider?.stripe_account_id && provider.payouts_enabled) {
    const { data: sub } = await admin
      .from('subscriptions')
      .select('commission_rate')
      .eq('provider_id', event.provider_id)
      .maybeSingle();
    const commission = sub?.commission_rate ?? DEFAULT_COMMISSION_RATE;
    connect = {
      payment_intent_data: {
        application_fee_amount: Math.round(charge.value * 100 * commission),
        transfer_data: { destination: provider.stripe_account_id },
      },
    };
  }

  try {
    const session = await getStripe().checkout.sessions.create({ ...params, ...connect });
    return NextResponse.json({ url: session.url });
  } catch (e) {
    // Confirmed live: an uncaught failure here (misconfigured Stripe key,
    // a transient Stripe outage) left the pending row in place — and
    // because of the one-pending-per-ticket-type unique index above, that
    // permanently blocked this user from ever retrying this ticket type
    // again. Deleting it here means a retry just creates a fresh reservation
    // + row, same as if this one had never been started; the Wix reservation
    // itself still expires on its own either way.
    await admin.from('event_ticket_orders').delete().eq('id', pending.id);
    console.error('Could not create Stripe Checkout session for a Wix event ticket', e);
    return NextResponse.json({ error: 'Could not start payment — try again' }, { status: 502 });
  }
}
