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
 * NOTE: the hosted database already uses a newer vocabulary — its
 * `plan_commission_rate` function labels 'growth' as "Pro" and 'pro' as
 * "Premium", matching the 24/08 QA rows — while the vendor frontend still
 * says Growth/Pro everywhere. These stay aligned with the frontend rather
 * than half-renamed; when the rename lands, it is this map and the frontend's
 * PLAN_META.
 */
const LABELS: Record<VendorPlan, string> = {
  free: 'Free',
  growth: 'Growth',
  pro: 'Pro',
  premium: 'Pro',
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
