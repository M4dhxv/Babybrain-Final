import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

/**
 * QA: "If you select a class to buy a package, that class should also then
 * be booked" — buying a pack from the booking page used to only grant
 * credits; the parent had to go back and manually redeem one. Called from
 * both the webhook and /api/stripe/reconcile (the webhook has a documented
 * history of not landing reliably in this project) right after a
 * `package_purchases` row is created.
 *
 * Deliberately best-effort and silent on failure: the credit grant above this
 * call is the part that must never be lost, so any mismatch here (session
 * filled up, pack restrictions no longer match, already booked) just leaves
 * the parent with their credits and no auto-booking — exactly today's
 * behaviour — rather than risking the purchase itself.
 */
export async function autoBookPackageSession(
  admin: SupabaseClient<Database>,
  params: {
    purchaseId: string;
    packageId: string;
    providerId: string;
    userId: string;
    activitySessionId: string;
    childId: string | null;
  }
): Promise<void> {
  try {
    // Idempotency: a webhook + a client-side reconcile call can both fire for
    // the same checkout — never book the same session twice off one purchase.
    const { data: existing } = await admin
      .from('bookings')
      .select('id')
      .eq('package_purchase_id', params.purchaseId)
      .eq('session_id', params.activitySessionId)
      .maybeSingle();
    if (existing) return;

    const { data: pkg } = await admin
      .from('packages')
      .select('activity_ids, allowed_weekday, allowed_start_time')
      .eq('id', params.packageId)
      .maybeSingle();
    if (!pkg) return;

    const { data: session } = await admin
      .from('activity_sessions')
      .select('id, starts_at, activity_id, activities(provider_id, bookings_paused)')
      .eq('id', params.activitySessionId)
      .maybeSingle();
    if (!session) return;
    const activity = session.activities as unknown as { provider_id: string | null; bookings_paused: boolean | null } | null;
    if (!activity || activity.provider_id !== params.providerId || activity.bookings_paused) return;
    if (pkg.activity_ids && pkg.activity_ids.length > 0 && !pkg.activity_ids.includes(session.activity_id)) return;

    if (pkg.allowed_weekday != null || pkg.allowed_start_time != null) {
      const sgt = new Date(
        new Date(session.starts_at).toLocaleString('en-US', { timeZone: 'Asia/Singapore' })
      );
      if (pkg.allowed_weekday != null && sgt.getDay() !== pkg.allowed_weekday) return;
      if (pkg.allowed_start_time != null) {
        const hhmmss = sgt.toTimeString().slice(0, 8);
        if (hhmmss !== pkg.allowed_start_time) return;
      }
    }

    // service_role bypasses enforce_booking_insert_defaults' own status
    // logic (it trusts the server path completely) — status/payment_status
    // are ours to set; the capacity trigger still overrides to 'waitlisted'
    // if the session has since filled up.
    const { data: booking, error: bookingErr } = await admin
      .from('bookings')
      .insert({
        user_id: params.userId,
        session_id: params.activitySessionId,
        child_id: params.childId,
        status: 'confirmed',
        payment_status: 'none',
        package_purchase_id: params.purchaseId,
      })
      .select('id')
      .single();
    if (bookingErr || !booking) return;

    // Decrement by exactly one from whatever the purchase currently holds
    // (read back rather than assuming the full amount, in case something
    // else already touched it).
    const { data: purchase } = await admin
      .from('package_purchases')
      .select('credits_remaining')
      .eq('id', params.purchaseId)
      .maybeSingle();
    if (purchase && purchase.credits_remaining > 0) {
      const remaining = purchase.credits_remaining - 1;
      await admin
        .from('package_purchases')
        .update({ credits_remaining: remaining, status: remaining <= 0 ? 'used' : 'active' })
        .eq('id', params.purchaseId);
    }
  } catch (e) {
    console.error('[autoBookPackageSession] failed, credits are unaffected:', e instanceof Error ? e.message : e);
  }
}
