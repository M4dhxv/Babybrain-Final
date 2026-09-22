import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

/**
 * Free-tier parents can't see Packages on /profile (Plus-gated — see
 * PlusLock in frontends/parent/src/pages/dashboard.tsx), so this
 * confirmation email is their only way to know what they bought and how to
 * use it. Called from both the Stripe webhook and /api/stripe/reconcile,
 * right after purchase_package_and_book (lib/stripe-package-purchase.ts,
 * migration 00162) grants the purchase — only when that call reports a fresh
 * grant, never on a deduped redelivery.
 *
 * The credit count is read back from the purchase AFTER any auto-booking, not
 * taken from the package: buying from a class's booking page books that class
 * (spending one credit per seat), so a 5-class pack can already be short a
 * few credits by the time this runs. Announcing the package total told
 * parents they had credits they'd already used.
 *
 * Never throws: a notification failure must not undo a purchase the parent
 * has already paid for.
 */
export async function notifyPackagePurchased(
  admin: SupabaseClient<Database>,
  params: { userId: string; packageId: string; providerId: string; purchaseId: string; credits: number }
): Promise<void> {
  try {
    const [{ data: pkg }, { data: provider }, { data: purchase }, { data: bookedRows }] = await Promise.all([
      admin.from('packages').select('name, activity_ids').eq('id', params.packageId).maybeSingle(),
      admin.from('providers').select('business_name').eq('id', params.providerId).maybeSingle(),
      admin.from('package_purchases').select('credits_remaining').eq('id', params.purchaseId).maybeSingle(),
      // The class the purchase auto-booked, if any (autoBookPackageSession).
      admin
        .from('bookings')
        .select('activity_sessions(activities(title))')
        .eq('package_purchase_id', params.purchaseId)
        .limit(1),
    ]);

    // What's actually left, not what the pack started with. Falls back to the
    // package total only if the purchase row can't be read back.
    const creditsLeft = purchase?.credits_remaining ?? params.credits;
    const bookedSession = bookedRows?.[0]?.activity_sessions as unknown as { activities: { title: string } | null } | null;
    const bookedActivity = bookedRows?.length ? (bookedSession?.activities?.title ?? 'a class') : null;

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
      body: bookedActivity
        ? `Your package with ${provider?.business_name ?? 'your provider'} is ready — you're booked onto ${bookedActivity}, with ${creditsLeft} ${creditsLeft === 1 ? 'credit' : 'credits'} left.`
        : `Your ${creditsLeft}-credit package with ${provider?.business_name ?? 'your provider'} is ready — book your first class.`,
      data: {
        package_name: pkg?.name ?? null,
        provider_name: provider?.business_name ?? null,
        // Credits LEFT after any auto-booking; `credits_total` is the pack size.
        credits: creditsLeft,
        credits_total: params.credits,
        booked_activity: bookedActivity,
        url,
      },
    });
  } catch (e) {
    console.error('[notifyPackagePurchased] failed, credits are unaffected:', e instanceof Error ? e.message : e);
  }
}
