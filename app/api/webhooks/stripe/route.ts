import { NextResponse } from 'next/server';
import type Stripe from 'stripe';
import { getStripe } from '@/lib/stripe';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Single source of truth for billing state. Signature-verified.
 * Handles: subscription lifecycle, Connect account.updated, and one-off
 * payments (boost + booking). The client never writes subscriptions.
 *
 * Configure the endpoint + signing secret in the Stripe Dashboard:
 *   https://<domain>/api/webhooks/stripe  →  STRIPE_WEBHOOK_SECRET
 */
export async function POST(request: Request) {
  const body = await request.text();
  const sig = request.headers.get('stripe-signature') ?? '';
  const stripe = getStripe();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  const admin = createAdminClient();

  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      const active = ['active', 'trialing'].includes(sub.status);
      const periodEnd = (sub as unknown as { current_period_end?: number }).current_period_end;
      const periodEndIso = periodEnd ? new Date(periodEnd * 1000).toISOString() : null;

      // Vendor "Growth" subscription (unchanged).
      const providerId = sub.metadata?.provider_id;
      if (providerId) {
        await admin
          .from('subscriptions')
          .update({
            plan: active ? 'growth' : 'free',
            stripe_subscription_id: sub.id,
            status: sub.status as never,
            current_period_end: periodEndIso,
            cancel_at_period_end: sub.cancel_at_period_end,
          })
          .eq('provider_id', providerId);
      }

      // Customer "Plus" subscription.
      const customerUserId = sub.metadata?.user_id;
      if (customerUserId) {
        await admin.from('customer_subscriptions').upsert(
          {
            user_id: customerUserId,
            plan: active ? 'plus' : 'free',
            stripe_subscription_id: sub.id,
            status: sub.status as never,
            current_period_end: periodEndIso,
            cancel_at_period_end: sub.cancel_at_period_end,
          },
          { onConflict: 'user_id' }
        );
      }
      break;
    }

    case 'customer.subscription.trial_will_end':
    case 'invoice.payment_failed': {
      // Subscription-related comms → notify the provider owner(s).
      const obj = event.data.object as Stripe.Subscription | Stripe.Invoice;
      const customerId =
        typeof obj.customer === 'string' ? obj.customer : obj.customer?.id;
      if (customerId) {
        const { data: sub } = await admin
          .from('subscriptions')
          .select('provider_id')
          .eq('stripe_customer_id', customerId)
          .maybeSingle();
        if (sub?.provider_id) {
          const { data: owners } = await admin
            .from('provider_members')
            .select('user_id')
            .eq('provider_id', sub.provider_id)
            .eq('role', 'owner')
            .eq('status', 'active');
          const isTrial = event.type === 'customer.subscription.trial_will_end';
          await admin.from('notifications').insert(
            (owners ?? []).map((o) => ({
              user_id: o.user_id,
              type: isTrial ? 'trial_ending' : 'payment_failed',
              title: isTrial ? 'Your free trial is ending soon' : 'Payment failed',
              body: isTrial
                ? 'Add a payment method to keep your Growth features active.'
                : 'We couldn’t process your subscription payment. Please update your card.',
              data: { url: '/vendor/billing' },
            }))
          );
        }
      }
      break;
    }

    case 'account.updated': {
      const account = event.data.object as Stripe.Account;
      const providerId = account.metadata?.provider_id;
      if (providerId) {
        await admin
          .from('providers')
          .update({ payouts_enabled: Boolean(account.charges_enabled && account.payouts_enabled) })
          .eq('id', providerId);
      }
      break;
    }

    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const session = event.data.object as Stripe.Checkout.Session;
      const kind = session.metadata?.kind;

      if (kind === 'boost' && session.metadata?.activity_id) {
        const days = Number(session.metadata.days ?? 14);
        await admin
          .from('activities')
          .update({
            boosted_until: new Date(Date.now() + days * 864e5).toISOString(),
          })
          .eq('id', session.metadata.activity_id);
      }

      if (kind === 'booking' && session.metadata?.booking_id) {
        await admin
          .from('bookings')
          .update({
            payment_status: 'paid',
            status: 'confirmed',
            stripe_payment_intent: (session.payment_intent as string) ?? null,
          })
          .eq('id', session.metadata.booking_id);
      }

      if (kind === 'package' && session.metadata?.package_id && session.metadata?.user_id) {
        const { data: pkg } = await admin
          .from('packages')
          .select('id, provider_id, credits')
          .eq('id', session.metadata.package_id)
          .maybeSingle();
        if (pkg) {
          await admin.from('package_purchases').insert({
            user_id: session.metadata.user_id,
            package_id: pkg.id,
            provider_id: pkg.provider_id,
            credits_total: pkg.credits,
            credits_remaining: pkg.credits,
            stripe_payment_intent: (session.payment_intent as string) ?? null,
          });
        }
      }
      break;
    }

    default:
      break;
  }

  return NextResponse.json({ received: true });
}
