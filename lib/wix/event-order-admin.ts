import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { getStripe } from '@/lib/stripe';
import { notifyEventTicketRefunded } from './event-notify';
import { CLAIM_WINDOW_MS } from './finalize-event-checkout';

type Admin = SupabaseClient<Database>;

/** A paid Wix Events ticket that Wix has not (yet) accepted — what Admin → Payments shows. */
export interface StuckEventOrder {
  id: string;
  createdAt: string;
  amount: number | null;
  attempts: number;
  lastAttemptAt: string | null;
  error: string | null;
  paymentIntent: string | null;
  eventTitle: string | null;
  businessName: string | null;
  parent: { name: string | null; email: string | null };
}

/** Paid, but the order was never created on the vendor's Wix:
 *  status 'pending' with payment_status 'paid'. */
export async function listStuckEventOrders(admin: Admin): Promise<StuckEventOrder[]> {
  const { data: rows } = await admin
    .from('event_ticket_orders')
    .select(
      'id, created_at, amount, fulfilment_attempts, fulfilment_last_attempt_at, fulfilment_error, stripe_payment_intent, user_id, event_id'
    )
    .eq('status', 'pending')
    .eq('payment_status', 'paid')
    .order('created_at', { ascending: false })
    .limit(100);
  if (!(rows ?? []).length) return [];

  const eventIds = [...new Set((rows ?? []).map((r) => r.event_id))];
  const userIds = [...new Set((rows ?? []).map((r) => r.user_id))];
  const [{ data: events }, { data: parents }] = await Promise.all([
    admin.from('wix_events').select('id, title, provider_id').in('id', eventIds),
    admin.from('parent_profiles').select('id, full_name, email').in('id', userIds),
  ]);
  const providerIds = [...new Set((events ?? []).map((e) => e.provider_id))];
  const { data: providers } = providerIds.length
    ? await admin.from('providers').select('id, business_name').in('id', providerIds)
    : { data: [] };
  const eventById = new Map((events ?? []).map((e) => [e.id, e]));
  const parentById = new Map((parents ?? []).map((p) => [p.id, p]));
  const providerById = new Map((providers ?? []).map((p) => [p.id, p.business_name]));

  return (rows ?? []).map((r) => {
    const ev = eventById.get(r.event_id);
    const parent = parentById.get(r.user_id);
    return {
      id: r.id,
      createdAt: r.created_at,
      amount: r.amount,
      attempts: r.fulfilment_attempts,
      lastAttemptAt: r.fulfilment_last_attempt_at,
      error: r.fulfilment_error,
      paymentIntent: r.stripe_payment_intent,
      eventTitle: ev?.title ?? null,
      businessName: ev ? providerById.get(ev.provider_id) ?? null : null,
      parent: { name: parent?.full_name ?? null, email: parent?.email ?? null },
    };
  });
}

export type RefundResult = { ok: true; refundId: string; wixOrderNumber: string | null } | { ok: false; error: string };

/**
 * Refunds the parent for a Wix Events ticket in full — used when the order
 * can't be created on the vendor's Wix, or an admin decides to make it right
 * with money rather than a make-up token. For a vendor on Stripe Connect the
 * transfer to the vendor and BabyBrain's application fee are reversed too, so
 * the platform isn't left paying for it. Idempotent on the order (Stripe
 * idempotency key), so a double click refunds once.
 *
 * Wix offers no way to cancel an order over the API (only to archive it), so
 * when the order *does* exist on the vendor's Wix the admin has to cancel it
 * there — the result says so, and the reconcile job then sees the order
 * cancelled and keeps both sides consistent.
 */
export async function refundWixEventOrder(admin: Admin, orderId: string): Promise<RefundResult> {
  const { data: order } = await admin
    .from('event_ticket_orders')
    .select('id, user_id, event_id, amount, payment_status, status, stripe_payment_intent, wix_order_number, fulfilment_last_attempt_at')
    .eq('id', orderId)
    .maybeSingle();
  if (!order) return { ok: false, error: 'No such order.' };
  if (order.payment_status === 'refunded') return { ok: false, error: 'This order has already been refunded.' };
  if (order.payment_status !== 'paid' || !order.stripe_payment_intent) {
    return { ok: false, error: 'There is no payment on this order to refund.' };
  }
  // An attempt to create the Wix order may still be running; refunding now could leave the parent with
  // both a refund and a ticket. Wait for it to finish.
  if (
    !order.wix_order_number &&
    order.fulfilment_last_attempt_at &&
    Date.now() - Date.parse(order.fulfilment_last_attempt_at) < CLAIM_WINDOW_MS
  ) {
    return { ok: false, error: 'An attempt to create this order on Wix is still in progress — try again in a few minutes.' };
  }

  const stripe = getStripe();
  let refund: Stripe.Refund;
  try {
    const pi = await stripe.paymentIntents.retrieve(order.stripe_payment_intent);
    const connect = !!pi.transfer_data?.destination;
    refund = await stripe.refunds.create(
      {
        payment_intent: order.stripe_payment_intent,
        ...(connect ? { reverse_transfer: true, refund_application_fee: true } : {}),
        metadata: { kind: 'wix_event_ticket', order_id: order.id },
      },
      { idempotencyKey: `wix-event-refund-${order.id}` }
    );
  } catch (e) {
    return { ok: false, error: `Stripe refused the refund: ${e instanceof Error ? e.message : String(e)}` };
  }

  await admin
    .from('event_ticket_orders')
    .update({
      status: 'cancelled',
      payment_status: 'refunded',
      refunded_at: new Date().toISOString(),
      stripe_refund_id: refund.id,
    })
    .eq('id', order.id);
  // Any seats already written for this payment go too (a fulfilled order refunded after the fact).
  await admin
    .from('bookings')
    .update({ status: 'cancelled', cancel_refund_mode: 'refund', cancel_reason: 'Refunded by BabyBrain' })
    .eq('user_id', order.user_id)
    .eq('stripe_payment_intent', order.stripe_payment_intent)
    .in('status', ['pending', 'confirmed', 'waitlisted']);
  // The vendor's ledger entry for this payment, if one was recorded.
  await admin.from('provider_earnings').update({ status: 'refunded' }).eq('stripe_payment_intent', order.stripe_payment_intent);

  const { data: ev } = await admin.from('wix_events').select('title').eq('id', order.event_id).maybeSingle();
  await notifyEventTicketRefunded(admin, { userId: order.user_id, eventTitle: ev?.title ?? null, amount: order.amount, orderId: order.id });

  return { ok: true, refundId: refund.id, wixOrderNumber: order.wix_order_number };
}
