import { NextResponse } from 'next/server';
import type Stripe from 'stripe';
import { getStripe } from '@/lib/stripe';
import { createAdminClient } from '@/lib/supabase/admin';
import { autoBookPackageSession } from '@/lib/stripe-package-auto-book';
import { recordSale } from '@/lib/commercials';
import { applyPayout } from '@/lib/payouts';
import { markEarningRefunded } from '@/lib/refunds';
import { dbStatus, planFromMetadata, type PaidPlan } from '@/lib/plans';
import { finalizeWixBookingCheckout } from '@/lib/wix/finalize-checkout';
import { finalizeWixEventTicketCheckout } from '@/lib/wix/finalize-event-checkout';

/**
 * Single source of truth for billing state. Signature-verified.
 * Handles: subscription lifecycle, Connect account.updated, and one-off
 * payments (boost + booking). The client never writes subscriptions.
 *
 * Configure the endpoint + signing secret in the Stripe Dashboard:
 *   https://<domain>/api/webhooks/stripe  →  STRIPE_WEBHOOK_SECRET
 *
 * Connect events (`account.*`, `payout.*` on a vendor's own account) are only
 * ever delivered to an endpoint created with `connect: true`, which is a
 * separate endpoint with its own signing secret. Point both at this route and
 * set STRIPE_CONNECT_WEBHOOK_SECRET as well — each delivery is verified
 * against whichever secret matches.
 */

/** Every signing secret this route accepts, in the order they're tried. */
function signingSecrets(): string[] {
  return [process.env.STRIPE_WEBHOOK_SECRET, process.env.STRIPE_CONNECT_WEBHOOK_SECRET].filter(
    (secret): secret is string => Boolean(secret)
  );
}

/**
 * Which tier a price belongs to, by looking it up in the same `app_config`
 * catalog the checkout route buys from. Returns null for a price we don't
 * recognise (a legacy or hand-made one), so the caller can fall back to the
 * subscription's metadata rather than guessing a tier wrong.
 */
/**
 * Another still-live subscription for the same provider, when one ends.
 *
 * Only asked on a cancellation, so the common path costs no extra Stripe
 * call. Restricted to this provider's own subscriptions so a customer record
 * shared with anything else can't be mistaken for the vendor's plan.
 */
async function liveSubscriptionFor(
  ended: Stripe.Subscription,
  providerId: string
): Promise<Stripe.Subscription | null> {
  const customerId = typeof ended.customer === 'string' ? ended.customer : ended.customer?.id;
  if (!customerId) return null;
  try {
    const all = await getStripe().subscriptions.list({ customer: customerId, status: 'all', limit: 100 });
    return (
      all.data
        .filter((s) => s.id !== ended.id)
        .filter((s) => s.metadata?.provider_id === providerId)
        .filter((s) => ['active', 'trialing', 'past_due', 'unpaid'].includes(s.status))
        .sort((a, b) => a.created - b.created)[0] ?? null
    );
  } catch {
    // Bookkeeping detail — never fail the webhook over it. Falling through
    // means the old behaviour (drop to Free), which is right far more often
    // than not.
    return null;
  }
}

async function planForPrice(
  admin: ReturnType<typeof createAdminClient>,
  priceId: string | undefined
): Promise<PaidPlan | null> {
  if (!priceId) return null;
  const { data } = await admin
    .from('app_config')
    .select('key, value')
    .in('key', [
      'stripe_growth_price_id',
      'stripe_growth_price_id_annual',
      'stripe_pro_price_id',
      'stripe_pro_price_id_annual',
    ]);
  const match = data?.find((row) => row.value === priceId);
  if (!match) return null;
  return match.key.startsWith('stripe_pro_') ? 'pro' : 'growth';
}

// Every Wix API call is bounded at 20s by wixFetch, and these routes make
// several of them back to back (resolve a slot, create the booking, confirm
// it). On the platform default (~10s) a slow-but-healthy Wix response gets
// the function killed mid-flight and the user sees a bare network error —
// for credentials/bookings that were perfectly fine. Same 60s ceiling the
// other Wix routes already set.
export const maxDuration = 60;

export async function POST(request: Request) {
  const body = await request.text();
  const sig = request.headers.get('stripe-signature') ?? '';
  const stripe = getStripe();

  let event: Stripe.Event | null = null;
  for (const secret of signingSecrets()) {
    try {
      event = stripe.webhooks.constructEvent(body, sig, secret);
      break;
    } catch {
      // Wrong secret for this endpoint — try the next one.
    }
  }
  if (!event) {
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

      // Vendor subscription — Growth or Pro.
      //
      // The tier is read off the PRICE the subscription is actually billing,
      // falling back to its metadata. Metadata alone was wrong the moment a
      // plan could change after checkout: a switch made in the Stripe billing
      // portal moves the price but leaves `metadata.plan` on the old tier, so
      // a vendor who downgraded Pro → Growth in the portal kept Pro in our
      // database (and Pro's 10% commission) indefinitely.
      const providerId = sub.metadata?.provider_id;
      if (providerId) {
        const vendorPlan =
          (await planForPrice(admin, sub.items.data[0]?.price?.id)) ?? planFromMetadata(sub.metadata);

        // A cancellation only drops the vendor to Free if it was their LAST
        // live subscription. Writing 'free' unconditionally cost a paying
        // vendor their tier whenever one of several subscriptions ended —
        // which is exactly what happened when the eight duplicates the demo
        // account had accumulated were cancelled: eight `deleted` events
        // landed and left a still-subscribed vendor recorded as Free.
        const survivor = active ? null : await liveSubscriptionFor(sub, providerId);
        const row = survivor ?? sub;
        const rowActive = active || Boolean(survivor);
        const rowPlan = survivor
          ? (await planForPrice(admin, survivor.items.data[0]?.price?.id)) ??
            planFromMetadata(survivor.metadata)
          : vendorPlan;
        const rowPeriodEnd = (row as unknown as { current_period_end?: number }).current_period_end;

        await admin
          .from('subscriptions')
          .update({
            plan: rowActive ? rowPlan : 'free',
            stripe_subscription_id: row.id,
            status: dbStatus(row.status) as never,
            current_period_end: rowPeriodEnd ? new Date(rowPeriodEnd * 1000).toISOString() : null,
            cancel_at_period_end: row.cancel_at_period_end,
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
            status: dbStatus(sub.status) as never,
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
              data: { url: '/vendor/#/billing' },
            }))
          );
        }
      }
      break;
    }

    case 'account.updated':
    case 'account.application.deauthorized': {
      const account = event.data.object as Stripe.Account;
      // Prefer the id we stored over the metadata: metadata can be edited
      // away in the Stripe dashboard, and accounts created before it was set
      // have none — those used to silently never flip payouts_enabled.
      let providerId = account.metadata?.provider_id ?? null;
      if (!providerId) {
        const { data: match } = await admin
          .from('providers')
          .select('id')
          .eq('stripe_account_id', account.id)
          .maybeSingle();
        providerId = match?.id ?? null;
      }
      if (!providerId) break;

      const deauthorized = event.type === 'account.application.deauthorized';
      const enabled =
        !deauthorized && Boolean(account.charges_enabled && account.payouts_enabled);

      const { data: before } = await admin
        .from('providers')
        .select('payouts_enabled')
        .eq('id', providerId)
        .maybeSingle();
      await admin.from('providers').update({ payouts_enabled: enabled }).eq('id', providerId);

      // Tell the owners when payouts turn on, or when Stripe takes them away
      // again — otherwise the only signal is a badge they have to go look at.
      if (before && before.payouts_enabled !== enabled) {
        const { data: owners } = await admin
          .from('provider_members')
          .select('user_id')
          .eq('provider_id', providerId)
          .eq('role', 'owner')
          .eq('status', 'active');
        await admin.from('notifications').insert(
          (owners ?? []).map((o) => ({
            user_id: o.user_id,
            type: 'payouts_status',
            title: enabled ? 'Payouts are live' : 'Payouts are on hold',
            body: enabled
              ? 'Stripe finished verifying your business — booking payments now go straight to your bank account.'
              : 'Stripe needs more information before it can pay you out. Open Billing to finish up.',
            data: { url: '/vendor/#/billing' },
          }))
        );
      }
      break;
    }

    case 'checkout.session.expired': {
      // Stripe abandons a session ~30 min after it's created. Release the
      // local pending event-ticket order now so its one-per-ticket-type slot
      // frees immediately, instead of the user having to trip the stale-row
      // sweep in the checkout route on a later attempt. The Wix reservation
      // releases itself. (Needs 'checkout.session.expired' enabled on the
      // endpoint — see scripts/setup-stripe-webhooks.mjs.)
      const expired = event.data.object as Stripe.Checkout.Session;
      if (expired.metadata?.kind === 'wix_event_ticket' && expired.metadata?.order_id) {
        await admin
          .from('event_ticket_orders')
          .delete()
          .eq('id', expired.metadata.order_id)
          .eq('status', 'pending')
          .eq('payment_status', 'none');
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
        const bookingId = session.metadata.booking_id;
        const paymentIntent = (session.payment_intent as string) ?? null;
        await admin
          .from('bookings')
          .update({
            payment_status: 'paid',
            status: 'confirmed',
            stripe_payment_intent: paymentIntent,
          })
          .eq('id', bookingId);

        // Ledger entry so the vendor can see what they earned on this booking
        // and what was deducted. Idempotent on the payment intent.
        // provider_id is stamped on the booking by handle_booking_insert.
        const { data: booked } = await admin
          .from('bookings')
          .select('amount, provider_id')
          .eq('id', bookingId)
          .maybeSingle();
        if (booked?.provider_id) {
          await recordSale(admin, {
            providerId: booked.provider_id,
            source: 'booking',
            bookingId,
            grossCents: Math.round(Number(booked.amount ?? 0) * 100),
            paymentIntentId: paymentIntent,
          });
        }
      }

      if (kind === 'wix_booking') {
        await finalizeWixBookingCheckout(admin, session);
      }

      if (kind === 'wix_event_ticket') {
        await finalizeWixEventTicketCheckout(admin, session);
      }

      if (kind === 'package' && session.metadata?.package_id && session.metadata?.user_id) {
        // Idempotency. Stripe retries a webhook whenever the endpoint is slow
        // or errors, and /api/stripe/reconcile processes the same checkout on
        // the parent's return — that fallback exists because this webhook has
        // a history of not landing. Without this guard, the second delivery
        // granted a whole extra pack and auto-booked the class a second time
        // (found in QA: replaying one event produced two purchases and two
        // bookings). Reconcile already guards this way; the webhook didn't.
        const paymentIntent = (session.payment_intent as string) ?? null;
        const { data: already } = paymentIntent
          ? await admin
              .from('package_purchases')
              .select('id')
              .eq('stripe_payment_intent', paymentIntent)
              .maybeSingle()
          : { data: null };

        const { data: pkg } = already
          ? { data: null }
          : await admin
              .from('packages')
              .select('id, provider_id, credits, price_cents')
              .eq('id', session.metadata.package_id)
              .maybeSingle();
        if (pkg) {
          const { data: purchase } = await admin
            .from('package_purchases')
            .insert({
              user_id: session.metadata.user_id,
              package_id: pkg.id,
              provider_id: pkg.provider_id,
              credits_total: pkg.credits,
              credits_remaining: pkg.credits,
              stripe_payment_intent: (session.payment_intent as string) ?? null,
            })
            .select('id')
            .single();
          // QA: buying a pack from a class's booking page should book that
          // class, not just grant credits. Only present when checkout was
          // started from there — see app/api/customer/stripe/package.
          if (purchase && session.metadata?.activity_session_id) {
            await autoBookPackageSession(admin, {
              purchaseId: purchase.id,
              packageId: pkg.id,
              providerId: pkg.provider_id,
              userId: session.metadata.user_id,
              activitySessionId: session.metadata.activity_session_id,
              childId: session.metadata.child_id ?? null,
            });
          }
          if (purchase) {
            await recordSale(admin, {
              providerId: pkg.provider_id,
              source: 'package',
              packagePurchaseId: purchase.id,
              grossCents: pkg.price_cents,
              paymentIntentId: paymentIntent,
            });
          }
        }
      }

      // Record the Plus subscription off the checkout event too, not only off
      // customer.subscription.created — so the plan flips even if that event
      // isn't enabled on the webhook endpoint. Retrieve the subscription for
      // its real status/period.
      if (kind === 'customer_subscription' && session.metadata?.user_id && session.subscription) {
        const sub = await getStripe().subscriptions.retrieve(session.subscription as string);
        const active = ['active', 'trialing'].includes(sub.status);
        const periodEnd = (sub as unknown as { current_period_end?: number }).current_period_end;
        await admin.from('customer_subscriptions').upsert(
          {
            user_id: session.metadata.user_id,
            plan: active ? 'plus' : 'free',
            stripe_subscription_id: sub.id,
            status: dbStatus(sub.status) as never,
            current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
            cancel_at_period_end: sub.cancel_at_period_end,
          },
          { onConflict: 'user_id' }
        );
      }
      break;
    }

    case 'charge.refunded': {
      // Covers refunds we issued AND refunds a vendor made straight from their
      // Express dashboard — for those, this is the only path that runs, so the
      // ledger and the booking would otherwise keep claiming the money.
      const charge = event.data.object as Stripe.Charge;
      const paymentIntent =
        typeof charge.payment_intent === 'string'
          ? charge.payment_intent
          : charge.payment_intent?.id ?? null;
      if (!paymentIntent) break;

      const full = charge.amount_refunded >= charge.amount;
      if (full) {
        await admin
          .from('bookings')
          .update({ payment_status: 'refunded', status: 'cancelled' })
          .eq('stripe_payment_intent', paymentIntent);
      }
      await markEarningRefunded(admin, paymentIntent, full);
      break;
    }

    case 'charge.dispute.created': {
      // A chargeback takes the money back immediately. Treat it like a refund
      // for reporting, and tell the owners — they have evidence to submit and
      // a deadline, and BabyBrain is the merchant of record on these.
      const dispute = event.data.object as Stripe.Dispute;
      const paymentIntent =
        typeof dispute.payment_intent === 'string'
          ? dispute.payment_intent
          : dispute.payment_intent?.id ?? null;
      if (!paymentIntent) break;

      const { data: earning } = await admin
        .from('provider_earnings')
        .select('provider_id')
        .eq('stripe_payment_intent', paymentIntent)
        .maybeSingle();
      await markEarningRefunded(admin, paymentIntent, true);

      if (earning?.provider_id) {
        const { data: owners } = await admin
          .from('provider_members')
          .select('user_id')
          .eq('provider_id', earning.provider_id)
          .eq('role', 'owner')
          .eq('status', 'active');
        await admin.from('notifications').insert(
          (owners ?? []).map((o) => ({
            user_id: o.user_id,
            type: 'payment_disputed',
            title: 'A parent disputed a payment',
            body: 'The amount has been held while the bank reviews it. We may ask you for class records as evidence.',
            data: { url: '/vendor/#/earnings' },
          }))
        );
      }
      break;
    }

    case 'payout.paid':
    case 'payout.failed':
    case 'payout.canceled':
    case 'payout.created':
    case 'payout.updated': {
      // Connect events: `event.account` is the vendor's account, not ours.
      // This is what turns "earned" into "paid out, on this date" on the
      // vendor's earnings page.
      const payout = event.data.object as Stripe.Payout;
      if (event.account) await applyPayout(admin, event.account, payout);
      break;
    }

    default:
      break;
  }

  return NextResponse.json({ received: true });
}
