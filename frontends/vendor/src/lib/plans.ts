import type { SubscriptionPlan } from './database.types';

export interface PlanMeta {
  key: SubscriptionPlan;
  label: string;       // e.g. "Growth (Booking Platform)"
  short: string;       // e.g. "Growth Plan"
  price: string;       // e.g. "SGD 99 / month"
  tagline: string;
  isPaid: boolean;
}

/**
 * Vendor subscription tiers. The backend Stripe flow currently flips between
 * `free` and `growth`; `pro`/`premium` are defined here so the UI renders them
 * correctly if/when they're wired, and never mislabels the real plan.
 */
export const PLAN_META: Record<string, PlanMeta> = {
  free: { key: 'free', label: 'Free (Listing)', short: 'Free Plan', price: 'SGD 0 / month', tagline: 'List your business · basic visibility', isPaid: false },
  growth: { key: 'growth', label: 'Growth (Booking Platform)', short: 'Growth Plan', price: 'SGD 99 / month', tagline: 'Manage bookings & grow · all core features', isPaid: true },
  pro: { key: 'pro', label: 'Pro (Scale)', short: 'Pro Plan', price: 'SGD 199 / month', tagline: 'Featured placement, priority ranking & advanced analytics', isPaid: true },
  premium: { key: 'premium', label: 'Premium', short: 'Premium Plan', price: 'SGD 349 / month', tagline: 'Everything in Pro, plus premium support', isPaid: true },
};

export const planMeta = (plan: string | null | undefined): PlanMeta => PLAN_META[plan ?? 'free'] ?? PLAN_META.free;

/** The next tier up from a given plan, for "upgrade" CTAs. */
export const nextPlan = (plan: string | null | undefined): PlanMeta | null => {
  const order = ['free', 'growth', 'pro', 'premium'];
  const i = order.indexOf(plan ?? 'free');
  return i >= 0 && i < order.length - 1 ? PLAN_META[order[i + 1]] : null;
};
