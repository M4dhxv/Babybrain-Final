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
