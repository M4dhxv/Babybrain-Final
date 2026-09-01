import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import {
  WixApiError,
  checkoutWixEventOrder,
  confirmWixEventOrder,
  createWixTicketReservation,
  getProviderWixCredentials,
  type WixCheckoutResult,
} from './client';
import { resolveWixContact } from './sync';

function wixErrorCode(e: unknown): string | null {
  if (!(e instanceof WixApiError)) return null;
  try {
    return (JSON.parse(e.body)?.details?.applicationError?.code as string | undefined) ?? null;
  } catch {
    return null;
  }
}

/**
 * Finalizes a paid Wix Events ticket once Stripe confirms payment — the
 * mirror of finalizeWixBookingCheckout for the Events flow. Called from both
 * the webhook (`checkout.session.completed`) and /api/stripe/reconcile.
 *
 * Confirmed live against a real event that `options.markAsPaid` on Checkout
 * does NOT reliably move an order to PAID (see checkoutWixEventOrder) — so
 * this always follows up with a real Confirm Order call for anything that
 * doesn't come back FREE/PAID immediately.
 *
 * The trickiest part: a Wix ticket reservation expires in as little as 20
 * minutes (event-configured), but Stripe Checkout Sessions can't be made to
 * expire in under 30 (Stripe's own floor) — see
 * app/api/wix/events/checkout's `expires_at`. So a slow payer can come back
 * from Stripe with money already collected and a reservation that's already
 * gone. This handles that by creating one fresh reservation and retrying
 * once; only if that also fails (genuinely sold out in the interim) does it
 * fall back to the same "paid but not confirmed, needs a human" state
 * Bookings already uses for its own sold-out race.
 *
 * Idempotent: safe to call twice for the same checkout (webhook + reconcile
 * racing, or a retried webhook delivery).
 */
export async function finalizeWixEventTicketCheckout(
  admin: SupabaseClient<Database>,
  session: Pick<Stripe.Checkout.Session, 'metadata' | 'payment_intent'>
): Promise<void> {
  const orderId = session.metadata?.order_id;
  const wixEventId = session.metadata?.wix_event_id;
  const reservationId = session.metadata?.wix_reservation_id;
  if (!orderId || !wixEventId || !reservationId) return;

  const { data: row } = await admin
    .from('event_ticket_orders')
    .select('id, user_id, child_id, event_id, ticket_type_id, quantity, amount, payment_status, medical_disclosure')
    .eq('id', orderId)
    .maybeSingle();
  if (!row) return;
  if (row.payment_status === 'paid') return; // already finalized

  const { data: event } = await admin
    .from('wix_events')
    .select('provider_id')
    .eq('id', row.event_id)
    .maybeSingle();
  if (!event?.provider_id) {
    console.error('[finalizeWixEventTicketCheckout] event has no provider', row.event_id);
    return;
  }

  const { data: ticketType } = await admin
    .from('event_ticket_types')
    .select('wix_ticket_definition_id')
    .eq('id', row.ticket_type_id)
    .maybeSingle();
  if (!ticketType) {
    console.error('[finalizeWixEventTicketCheckout] ticket type missing', row.ticket_type_id);
    return;
  }

  const creds = await getProviderWixCredentials(admin, event.provider_id);
  if (!creds) {
    console.error('[finalizeWixEventTicketCheckout] provider Wix credentials missing', event.provider_id);
    return;
  }

  const contact = await resolveWixContact(admin, row.user_id);
  const paymentIntent =
    typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id ?? null;

  async function checkoutAndConfirm(resId: string): Promise<WixCheckoutResult & { tickets?: unknown[] }> {
    const checkout = await checkoutWixEventOrder(creds!, { eventId: wixEventId!, reservationId: resId, guest: contact });
    if (checkout.status === 'PAID' || checkout.status === 'FREE') return checkout;
    try {
      const confirmed = await confirmWixEventOrder(creds!, wixEventId!, checkout.orderNumber);
      return { ...checkout, status: confirmed.status, tickets: confirmed.tickets };
    } catch (e) {
      // ORDER_ACTION_NOT_AVAILABLE (428) means the order is no longer in a
      // confirmable state — either something else already confirmed it
      // (webhook + reconcile racing), or it was cancelled/expired between
      // checkout and confirm. Either way, checkout()'s own order/status is
      // the best info left; the caller decides what to do with it.
      if (wixErrorCode(e) === 'ORDER_ACTION_NOT_AVAILABLE') return checkout;
      throw e;
    }
  }

  let result: (WixCheckoutResult & { tickets?: unknown[] }) | null = null;
  let markPaidNotConfirmed = false;

  try {
    result = await checkoutAndConfirm(reservationId);
  } catch (e) {
    const code = wixErrorCode(e);
    if (code === 'RESERVATION_OCCUPIED') {
      // This exact reservationId already produced an order via another
      // caller (webhook + reconcile racing each other). Nothing more to do
      // here — whichever caller won will have marked this row paid, or is
      // about to. Bail out without touching anything.
      return;
    }
    if (code === 'RESERVATION_NOT_FOUND' || e instanceof WixApiError && e.status === 404) {
      // Stripe collected the money, but the ~20-30 min Wix hold lapsed
      // before checkout finished. Stripe already confirmed payment, so it's
      // reasonable to try once more for a fresh hold on the same ticket
      // type/quantity rather than immediately giving up.
      try {
        const fresh = await createWixTicketReservation(creds, ticketType.wix_ticket_definition_id, row.quantity);
        result = await checkoutAndConfirm(fresh.id);
      } catch (e2) {
        console.error(
          '[finalizeWixEventTicketCheckout] paid but the ticket type sold out before a retry could claim it — needs a manual refund',
          row.id, wixEventId, e2
        );
        markPaidNotConfirmed = true;
      }
    } else {
      console.error('[finalizeWixEventTicketCheckout] paid but could not create the Wix order — needs a manual refund', row.id, wixEventId, e);
      markPaidNotConfirmed = true;
    }
  }

  if (markPaidNotConfirmed || !result) {
    // Same rule as finalizeWixBookingCheckout: never silently leave a paid
    // row 'pending' forever, and never auto-refund a real money movement —
    // surface it for support to refund and follow up with the parent.
    await admin
      .from('event_ticket_orders')
      .update({ payment_status: 'paid', stripe_payment_intent: paymentIntent })
      .eq('id', row.id);
    return;
  }

  await admin
    .from('event_ticket_orders')
    .update({
      status: 'confirmed',
      payment_status: 'paid',
      stripe_payment_intent: paymentIntent,
      wix_order_number: result.orderNumber,
    })
    .eq('id', row.id);

  await mirrorEventTicketAsBookings(admin, {
    providerId: event.provider_id,
    localEventId: row.event_id,
    ticketTypeId: row.ticket_type_id,
    userId: row.user_id,
    childId: row.child_id,
    quantity: row.quantity,
    totalAmount: row.amount,
    stripePaymentIntent: paymentIntent,
    wixOrderNumber: result.orderNumber,
    paymentStatus: 'paid',
    medicalDisclosure: row.medical_disclosure,
  });
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
    totalAmount: number | null;
    stripePaymentIntent: string | null;
    wixOrderNumber: string;
    /** 'none' for a free RSVP, 'paid' once Stripe has actually collected money. */
    paymentStatus: 'none' | 'paid';
    /** Parent medical & health disclosure, when the event's activity asks for one. */
    medicalDisclosure?: string | null;
  }
): Promise<void> {
  const { data: activity } = await admin
    .from('activities')
    .select('id')
    .eq('provider_id', params.providerId)
    .eq('wix_event_id', params.localEventId)
    .maybeSingle();
  if (!activity) {
    console.error('[mirrorEventTicketAsBookings] no mirrored activity found — booking list will miss this purchase', params.localEventId);
    return;
  }
  const { data: eventSession } = await admin
    .from('activity_sessions')
    .select('id')
    .eq('activity_id', activity.id)
    .maybeSingle();
  if (!eventSession) {
    console.error('[mirrorEventTicketAsBookings] mirrored activity has no session row', activity.id);
    return;
  }

  const perSeat = params.totalAmount != null ? params.totalAmount / params.quantity : null;
  const rows = Array.from({ length: params.quantity }, () => ({
    user_id: params.userId,
    child_id: params.childId,
    session_id: eventSession.id,
    status: 'confirmed' as const,
    payment_status: params.paymentStatus,
    amount: perSeat,
    stripe_payment_intent: params.stripePaymentIntent,
    wix_booking_id: params.wixOrderNumber,
    wix_ticket_type_id: params.ticketTypeId,
    medical_disclosure: params.medicalDisclosure ?? null,
  }));
  const { error } = await admin.from('bookings').insert(rows);
  if (error) console.error('[mirrorEventTicketAsBookings] insert failed', error);
}
