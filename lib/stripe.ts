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
