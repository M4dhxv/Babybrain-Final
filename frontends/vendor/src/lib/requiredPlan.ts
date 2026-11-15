import type { Session } from '@supabase/supabase-js';
import type { Subscription } from '@/auth/AuthProvider';

/**
 * A paid plan agreed with a vendor before handover (e.g. on a call), which the
 * owner has to start, card and all, before they can use the portal.
 *
 * It lives in the owner's `app_metadata.onboarding_plan`, set by
 * `scripts/prepare-vendor-handover.mjs --require-plan=growth`. `app_metadata`
 * is writable only with the service role, so a vendor can't clear it
 * themselves. It is never cleared: once the subscription is live the step is
 * satisfied and does not come back, unless the plan lapses to free.
 *
 * Only `growth` (shown as "Pro", SGD 99/month) is supported for now.
 */
export type RequiredPlan = 'growth';

const PAID = ['growth', 'pro', 'premium'];
// Same set as LIVE_STATUSES in lib/stripe.ts: still holding the plan slot.
const LIVE = ['active', 'trialing', 'past_due', 'unpaid'];

export function requiredPlan(session: Session | null): RequiredPlan | null {
  const plan = session?.user?.app_metadata?.onboarding_plan;
  return plan === 'growth' ? plan : null;
}

/** True while the owner still has to start the agreed plan. Any live paid plan satisfies it. */
export function needsRequiredPlan(session: Session | null, subscription: Subscription | null): boolean {
  if (!requiredPlan(session)) return false;
  const paid = !!subscription && PAID.includes(subscription.plan) && LIVE.includes(subscription.status);
  return !paid;
}
