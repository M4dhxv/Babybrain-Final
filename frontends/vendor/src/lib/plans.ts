import type { SubscriptionPlan } from './database.types';

export interface PlanMeta {
  key: SubscriptionPlan;
  label: string;       // e.g. "Pro"
  short: string;       // e.g. "Pro Plan"
  price: string;       // e.g. "SGD 99 / month"
  commission: string;  // e.g. "10% commission"
  tagline: string;
  isPaid: boolean;
  perks: string[];
}

/**
 * Vendor subscription tiers, matching the vendor Plans page: Pay As You Grow
 * (free, `free` in the DB), Pro (`growth` in the DB — the plan/price-id keys
 * predate this rename and stay as-is to avoid touching Stripe config), and
 * Premium (`pro` in the DB). The legacy `premium` DB value is kept mapped to
 * the same content as `pro` (now the top tier) for any pre-existing rows.
 */
export const PLAN_META: Record<string, PlanMeta> = {
  free: {
    key: 'free',
    label: 'Pay As You Grow',
    short: 'Pay As You Grow',
    price: 'SGD 0 / month',
    commission: '12% commission',
    tagline: 'Take bookings & manage classes with no monthly fee',
    isPaid: false,
    perks: [
      'Create bespoke class schedule, package, pricing structure',
      'Custom integrations with existing platforms',
      'Availability, booking, waitlist, re-schedule and cancellation management',
      'Online waiver & policy management',
      'Stripe payment integration',
      'Package and make up token allocation',
      'Automated confirmations, reminders, follow ups etc',
      'Attendance tracking',
      'Onboarding and ongoing support',
    ],
  },
  growth: {
    key: 'growth',
    label: 'Pro',
    short: 'Pro Plan',
    price: 'SGD 99 / month',
    commission: '10% commission',
    tagline: 'Manage bookings & grow · all core features',
    isPaid: true,
    perks: [
      'Everything in Pay as you grow',
      'Direct to user messaging and user to user messaging on booked activities',
      'E-mails blasts with class availability twice a week',
      '1 bespoke marketing e-mail and 1 instagram post each month',
    ],
  },
  pro: {
    key: 'pro',
    label: 'Premium',
    short: 'Premium Plan',
    price: 'SGD 199 / month',
    commission: '8% commission',
    tagline: 'Featured placement, priority ranking & advanced analytics',
    isPaid: true,
    perks: ['Everything in Pro', 'Featured placement', 'Priority ranking', 'Activity performance analytics', 'Priority support'],
  },
  premium: {
    key: 'premium',
    label: 'Premium',
    short: 'Premium Plan',
    price: 'SGD 199 / month',
    commission: '8% commission',
    tagline: 'Featured placement, priority ranking & advanced analytics',
    isPaid: true,
    perks: ['Everything in Pro', 'Featured placement', 'Priority ranking', 'Activity performance analytics', 'Priority support'],
  },
};

export const planMeta = (plan: string | null | undefined): PlanMeta => PLAN_META[plan ?? 'free'] ?? PLAN_META.free;

/** The next tier up from a given plan, for "upgrade" CTAs. Pro (`pro`/`premium` in the DB) is the top tier. */
export const nextPlan = (plan: string | null | undefined): PlanMeta | null => {
  const order = ['free', 'growth', 'pro'];
  const key = plan === 'premium' ? 'pro' : (plan ?? 'free');
  const i = order.indexOf(key);
  return i >= 0 && i < order.length - 1 ? PLAN_META[order[i + 1]] : null;
};
