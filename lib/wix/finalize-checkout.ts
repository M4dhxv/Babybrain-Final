import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { recordSale } from '@/lib/commercials';
import { getProviderWixCredentials } from './client';
import { createWixBookingAndSession, resolveWixContact } from './sync';

/**
 * Finalizes a Wix-linked paid booking once Stripe confirms payment — the
 * moment the real reservation actually gets made in Wix (see
 * reserveWixSlotForCheckout in ./sync for why that's deferred this far).
 * Called from both the webhook (`checkout.session.completed`) and
 * /api/stripe/reconcile, same as the native booking/package kinds — the
 * webhook has a documented history of not landing reliably in this project.
 *
 * Idempotent: safe to call twice for the same checkout (webhook + reconcile
 * racing, or a retried webhook delivery) — a no-op once the rows are paid.
 */
export async function finalizeWixBookingCheckout(
  admin: SupabaseClient<Database>,
  session: Pick<Stripe.Checkout.Session, 'metadata' | 'payment_intent'>
): Promise<void> {
  const activityId = session.metadata?.activity_id;
  const wixSlotId = session.metadata?.wix_slot_id;
  const bookingIdsRaw = session.metadata?.booking_ids;
  if (!activityId || !wixSlotId || !bookingIdsRaw) return;

  let bookingIds: string[];
  try {
    bookingIds = JSON.parse(bookingIdsRaw);
  } catch {
    return;
  }
  if (!Array.isArray(bookingIds) || bookingIds.length === 0) return;

  const { data: rows } = await admin
    .from('bookings')
    .select('id, user_id, payment_status, amount')
    .in('id', bookingIds);
  if (!rows || rows.length === 0) return;
  if (rows.every((r) => r.payment_status === 'paid')) return; // already finalized

  const { data: activity } = await admin
    .from('activities')
    .select('id, provider_id, wix_service_id, wix_resource_id, wix_service_type')
    .eq('id', activityId)
    .maybeSingle();
  if (!activity?.wix_service_id || !activity.provider_id) {
    console.error('[finalizeWixBookingCheckout] activity no longer Wix-linked', activityId);
    return;
  }

  const creds = await getProviderWixCredentials(admin, activity.provider_id);
  if (!creds) {
    console.error('[finalizeWixBookingCheckout] provider Wix credentials missing', activity.provider_id);
    return;
  }

  const contact = await resolveWixContact(admin, rows[0].user_id);
  const result = await createWixBookingAndSession(
    admin,
    creds,
    {
      id: activity.id,
      wix_service_id: activity.wix_service_id,
      wix_resource_id: activity.wix_resource_id,
      wix_service_type: activity.wix_service_type,
    },
    wixSlotId,
    contact,
    rows.length
  );

  const paymentIntent =
    typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id ?? null;

  if (!result.ok) {
    // Payment succeeded but the slot's gone — lost a race on Wix while the
    // parent was on Stripe. There's no auto-refund here (a real money
    // action deserves a human, not a webhook), so this is left paid but not
    // confirmed rather than silently 'pending' forever, so it surfaces for
    // support to refund and follow up with the parent.
    console.error(
      '[finalizeWixBookingCheckout] paid but could not create the Wix booking — needs a manual refund',
      activityId, wixSlotId, result.error
    );
    await admin.from('bookings').update({ payment_status: 'paid', stripe_payment_intent: paymentIntent }).in('id', bookingIds);
    return;
  }

  // The pending rows already point at reserveWixSlotForCheckout's session id
  // — createWixBookingAndSession resolves to that same row (find-or-create,
  // keyed on wix_slot_key), so only status/payment need updating here.
  await admin
    .from('bookings')
    .update({
      status: 'confirmed',
      payment_status: 'paid',
      stripe_payment_intent: paymentIntent,
      wix_booking_id: result.wixBookingId,
    })
    .in('id', bookingIds);

  // Same ledger entry the native paid booking writes (the webhook's
  // kind='booking' branch). Without it a Wix-linked class sold through
  // BabyBrain took the parent's money, split it to the vendor's connected
  // account and then showed up nowhere in the vendor's Earnings — nothing
  // to reconcile a payout against. One entry for the whole checkout, gross
  // across every seat, keyed to the first booking row exactly as the native
  // path keys to its single one. recordSale is idempotent on the payment
  // intent, so the webhook and /api/stripe/reconcile racing is safe.
  const grossCents = rows.reduce((sum, r) => sum + Math.round(Number(r.amount ?? 0) * 100), 0);
  await recordSale(admin, {
    providerId: activity.provider_id,
    source: 'booking',
    bookingId: rows[0].id,
    grossCents,
    paymentIntentId: paymentIntent,
  });
}
