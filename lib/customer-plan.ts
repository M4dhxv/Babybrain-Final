import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

/**
 * Whether a parent is on the paid "Plus" plan - the same test the parent app
 * uses client-side (`usePlan().isPlus`, i.e. `customer_subscriptions.plan ===
 * 'plus'`; the Stripe webhook writes 'free' once a subscription is no longer
 * active). For features that are Plus-only in the UI and must not be reachable
 * by calling the API directly, e.g. the calendar subscription feed.
 *
 * Service-role client required. Fails closed: a lookup error counts as not Plus.
 */
export async function isPlusParent(admin: SupabaseClient<Database>, userId: string): Promise<boolean> {
  const { data, error } = await admin
    .from('customer_subscriptions')
    .select('plan')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    console.error('Plan lookup failed', error);
    return false;
  }
  return data?.plan === 'plus';
}
