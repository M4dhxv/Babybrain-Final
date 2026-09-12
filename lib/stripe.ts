import Stripe from 'stripe';

let client: Stripe | null = null;

/** Server-side Stripe client (holds the secret key). Never import client-side. */
export function getStripe(): Stripe {
  if (!client) {
    // Omit apiVersion → uses the version pinned by the installed SDK.
    client = new Stripe(process.env.STRIPE_SECRET_KEY!, { typescript: true });
  }
  return client;
}

export const GROWTH_TRIAL_DAYS = 30;
export const DEFAULT_COMMISSION_RATE = 0.15;

/**
 * Subscription statuses that mean "this customer is currently subscribed" —
 * i.e. Stripe is still billing it, or still trying to.
 *
 * Used wherever we ask Stripe what a customer already has instead of trusting
 * our own `stripe_subscription_id`, which records only the most recent one and
 * so cannot see a stacked duplicate. `past_due`/`unpaid` count as live: the
 * subscription exists and will resume on a successful retry, so treating one
 * as absent is what lets a second get created alongside it.
 */
export const LIVE_STATUSES = ['active', 'trialing', 'past_due', 'unpaid'];

/**
 * A subscription's `current_period_end` as an ISO string, or null.
 *
 * Read through an indirection because the field moved off the top level of
 * the Subscription object in recent API versions while the SDK's types still
 * differ by version; every caller was hand-rolling the same cast.
 */
export function periodEndIso(sub: { current_period_end?: number } | Stripe.Subscription): string | null {
  const end = (sub as unknown as { current_period_end?: number }).current_period_end;
  return end ? new Date(end * 1000).toISOString() : null;
}

/**
 * Our `billing_interval` vocabulary for the price a subscription is billing.
 *
 * Stripe says 'month'/'year'; the database columns and the checkout routes
 * say 'monthly'/'annual'. Returns null for anything else (weekly/daily prices,
 * or a subscription with no recurring item) so callers can leave the stored
 * value alone rather than writing a guess.
 */
export function intervalOf(sub: Stripe.Subscription): 'monthly' | 'annual' | null {
  const interval = sub.items.data[0]?.price?.recurring?.interval;
  if (interval === 'month') return 'monthly';
  if (interval === 'year') return 'annual';
  return null;
}

/**
 * Payment methods offered on every ONE-OFF checkout (class bookings, class
 * packs, Boost).
 *
 * Order is the order Stripe Checkout renders them in, so PayNow leads: it's
 * how most Singapore parents pay and it costs the least to process. Card
 * follows — which also surfaces the Apple Pay / Google Pay wallet buttons —
 * then GrabPay.
 *
 * Left to Stripe's own default, a one-off session comes back as
 * `card, paynow, link`: card first and no GrabPay at all. Hence setting it
 * explicitly, in one place, rather than per route.
 *
 * NOT used for subscriptions: PayNow and GrabPay are single-use methods and
 * can't back a recurring charge, so those sessions stay on Stripe's default
 * (card/Link).
 */
export const ONE_OFF_PAYMENT_METHODS: Stripe.Checkout.SessionCreateParams.PaymentMethodType[] = [
  'paynow',
  'card',
  'grabpay',
];
