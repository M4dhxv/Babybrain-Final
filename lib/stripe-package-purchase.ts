import type { SupabaseClient } from '@supabase/supabase-js';
import type Stripe from 'stripe';
import type { Database } from '@/types/database';
import { companionSettingsFor, readCompanionMetadata, saveCompanions, validateCompanions } from '@/lib/companions';

/**
 * Grants a pack's credits and, when the checkout carried a chosen class,
 * books that many seats and spends that many credits — all in one DB
 * transaction (purchase_package_and_book, migration 00162). Called from both
 * the Stripe webhook and /api/stripe/reconcile (the webhook has a documented
 * history of not landing reliably in this project) right after
 * `checkout.session.completed` confirms payment for a `kind: 'package'`
 * session.
 *
 * Replaces the old two-step "insert package_purchases, then separately
 * auto-book one seat" (lib/stripe-package-auto-book.ts) — that left a window
 * where credits were granted but the intended seat never got booked (or vice
 * versa isn't possible, but a crash between the two writes was), and always
 * booked exactly one seat regardless of how many children the parent picked.
 */
export async function purchasePackageAndBook(
  admin: SupabaseClient<Database>,
  session: Stripe.Checkout.Session
): Promise<{
  purchaseId: string;
  status: string;
  waitlistedCount: number;
  alreadyCredited: boolean;
  package: { id: string; provider_id: string; credits: number; price_cents: number } | null;
} | null> {
  const packageId = session.metadata?.package_id;
  const userId = session.metadata?.user_id;
  if (!packageId || !userId) return null;

  const { data: pkg } = await admin
    .from('packages')
    .select('id, provider_id, credits, price_cents')
    .eq('id', packageId)
    .maybeSingle();
  if (!pkg) return null;

  const activitySessionId = session.metadata?.activity_session_id ?? null;
  const quantity = Number(session.metadata?.quantity) || 1;
  const parseJsonArray = (raw: string | undefined): string[] => {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  };

  const { data, error } = await admin.rpc('purchase_package_and_book', {
    p_user_id: userId,
    p_package_id: packageId,
    p_stripe_payment_intent: (session.payment_intent as string) ?? null,
    p_activity_session_id: activitySessionId,
    p_child_id: session.metadata?.child_id ?? null,
    p_quantity: quantity,
    p_policies: parseJsonArray(session.metadata?.policies_accepted),
    p_medical: session.metadata?.medical_disclosure ?? null,
    // Split over two keys when long (app/api/customer/stripe/package).
    p_info: session.metadata?.info_response
      ? session.metadata.info_response + (session.metadata.info_response_2 ?? '')
      : null,
    p_guest_names: parseJsonArray(session.metadata?.guest_names),
  });
  if (error || !data || !data[0]) {
    console.error('[purchasePackageAndBook] failed:', error?.message ?? 'no rows returned');
    return null;
  }

  const row = data[0] as { purchase_id: string; status: string; waitlisted_count: number; already_credited: boolean };

  // Companion mode (00273): the companions the parent entered when buying the pack and booking this
  // class in one go ride along in the checkout metadata; attach them to the seats just booked. Saving
  // replaces, so the webhook and the return page both running can't double anyone up.
  const companions = readCompanionMetadata(session.metadata);
  if (companions.length > 0 && activitySessionId) {
    try {
      const { data: sess } = await admin
        .from('activity_sessions')
        .select('activities(id, provider_id)')
        .eq('id', activitySessionId)
        .maybeSingle();
      const activity = (sess?.activities ?? null) as unknown as { id: string; provider_id: string | null } | null;
      const { data: seats } = await admin
        .from('bookings')
        .select('id')
        .eq('package_purchase_id', row.purchase_id)
        .eq('session_id', activitySessionId)
        .order('created_at', { ascending: true });
      if (activity?.provider_id && seats && seats.length > 0) {
        const settings = await companionSettingsFor(admin as never, activity.id);
        const checked = settings ? validateCompanions(settings, seats.length, companions) : null;
        if (settings && checked?.ok) {
          await saveCompanions(admin as never, {
            userId,
            providerId: activity.provider_id,
            seatIds: seats.map((s) => s.id),
            type: settings.companion_type,
            list: checked.list,
          });
        }
      }
    } catch (e) {
      console.error('[purchasePackageAndBook] companions not saved:', e instanceof Error ? e.message : e);
    }
  }
  return {
    purchaseId: row.purchase_id,
    status: row.status,
    waitlistedCount: row.waitlisted_count,
    alreadyCredited: row.already_credited,
    package: pkg,
  };
}
