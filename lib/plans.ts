/**
 * Vendor plan vocabulary, shared by the Stripe routes and the webhook.
 *
 * The frontend has its own richer PLAN_META (labels, prices, taglines) for
 * rendering; this is deliberately just the parts the backend has to agree
 * with Stripe and the database about.
 */

/** Tiers that have a Stripe price and can be subscribed to. */
export const PAID_PLANS = ['growth', 'pro'] as const;
export type PaidPlan = (typeof PAID_PLANS)[number];

/**
 * Every value `subscriptions.plan` is allowed to hold.
 *
 * 'premium' is a legacy alias for the top tier: migration 00039 deliberately
 * excluded it, but the hosted database's CHECK constraint has since been
 * widened by hand and one provider is on it. It shares Pro's Stripe price, so
 * everything here treats the two as the same tier.
 */
export type VendorPlan = 'free' | PaidPlan | 'premium';

/**
 * Names shown to vendors.
 *
 * The DB keys predate the rename and are deliberately left alone so the
 * Stripe price-id config (`stripe_growth_price_id`, `stripe_pro_price_id`)
 * keeps working: 'growth' IS the plan the Plans page calls Pro, and 'pro' IS
 * the one it calls Premium. Kept in step with the vendor frontend's
 * PLAN_META and with plan_commission_rate() in migration 00064.
 */
const LABELS: Record<VendorPlan, string> = {
  free: 'Pay as you grow',
  growth: 'Pro',
  pro: 'Premium',
  premium: 'Premium',
};

export const planLabel = (plan: string): string => LABELS[plan as VendorPlan] ?? plan;

/**
 * Which tier a Stripe subscription represents, resolved from its metadata.
 *
 * Defaults to Growth rather than throwing: a subscription created before
 * `plan` was written to metadata is a Growth one, because Growth was the only
 * tier that existed then.
 */
export const planFromMetadata = (metadata: Record<string, string> | null | undefined): PaidPlan =>
  metadata?.plan === 'pro' ? 'pro' : 'growth';

/**
 * `subscriptions.status` has a CHECK constraint predating several of the
 * statuses Stripe actually sends. An unmapped value ('unpaid', 'paused',
 * 'incomplete_expired') fails the constraint, and because the webhook doesn't
 * inspect the update's error, the whole row — plan included — silently
 * doesn't get written. Everything unrecognised collapses to the nearest
 * allowed status instead.
 */
const STATUS_MAP: Record<string, string> = {
  active: 'active',
  trialing: 'trialing',
  past_due: 'past_due',
  unpaid: 'past_due',
  canceled: 'canceled',
  incomplete: 'incomplete',
  incomplete_expired: 'canceled',
  paused: 'canceled',
};

export const dbStatus = (stripeStatus: string): string => STATUS_MAP[stripeStatus] ?? 'canceled';
