import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

/**
 * Free-tier parents can't see Packages on /profile (Plus-gated — see
 * PlusLock in frontends/parent/src/pages/dashboard.tsx), so this
 * confirmation email is their only way to know what they bought and how to
 * use it. Called from both the Stripe webhook and /api/stripe/reconcile,
 * right after a package_purchases row is created — mirrors the idempotency
 * pattern of autoBookPackageSession (lib/stripe-package-auto-book.ts).
 *
 * Never throws: a notification failure must not undo a purchase the parent
 * has already paid for.
 */
export async function notifyPackagePurchased(
  admin: SupabaseClient<Database>,
  params: { userId: string; packageId: string; providerId: string; credits: number }
): Promise<void> {
  try {
    const [{ data: pkg }, { data: provider }] = await Promise.all([
      admin.from('packages').select('name, activity_ids').eq('id', params.packageId).maybeSingle(),
      admin.from('providers').select('business_name').eq('id', params.providerId).maybeSingle(),
    ]);

    // A pack tied to exactly one class can deep-link straight to booking it
    // (same rule PackageCard.bookHref uses); a pack spanning several classes,
    // or none, falls back to browsing the provider — there is no single
    // "book" page to send them to.
    const activityIds = pkg?.activity_ids ?? [];
    let url = `/explore?q=${encodeURIComponent(provider?.business_name ?? '')}`;
    if (activityIds.length === 1) {
      const { data: activity } = await admin
        .from('activities')
        .select('slug')
        .eq('id', activityIds[0])
        .maybeSingle();
      if (activity?.slug) url = `/book?slug=${activity.slug}`;
    }

    await admin.from('notifications').insert({
      user_id: params.userId,
      type: 'package_purchased',
      title: 'Your package is ready to use',
      body: `Your ${params.credits}-credit package with ${provider?.business_name ?? 'your provider'} is ready — book your first class.`,
      data: {
        package_name: pkg?.name ?? null,
        provider_name: provider?.business_name ?? null,
        credits: params.credits,
        url,
      },
    });
  } catch (e) {
    console.error('[notifyPackagePurchased] failed, credits are unaffected:', e instanceof Error ? e.message : e);
  }
}
