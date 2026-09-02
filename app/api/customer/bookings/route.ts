import { NextResponse } from 'next/server';
import { getAuthedContext } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * The signed-in parent's own booking history.
 *
 * The direct client-side query this replaces relied on RLS's "published
 * activities are public" policy, which has no exception for a parent looking
 * at their own past booking — so once a vendor removes/unpublishes an
 * activity, the nested activities/activity_sessions join silently came back
 * null and My Bookings fell back to a bare "Class" placeholder with no date.
 *
 * This route runs the equivalent of "select own bookings" (bookings.user_id
 * = the caller) through the service role instead, so the join isn't subject
 * to the activities/activity_sessions publish-gated policies at all.
 */
export async function GET(request: Request) {
  const { user } = await getAuthedContext(request);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const admin = createAdminClient();
  const { data, error } = await admin
    .from('bookings')
    .select(
      'id, status, created_at, child_id, package_purchase_id, payment_status, activity_sessions(starts_at, ends_at, activity_id, activities(title, slug, image_urls, address, allow_cancellation, allow_rescheduling, cancellation_cutoff_hours, reschedule_cutoff_hours, wix_removed_at, wix_missing_since, wix_service_type))'
    )
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = data ?? [];
  const allIds = rows.map((r) => r.id);

  // Was this booking made by redeeming a make-up token? (redeemed_booking_id
  // is cleared when such a booking is cancelled — 00081 — so this only ever
  // matches a live one.) And, for a cancelled booking, did an auto make-up
  // token get minted to compensate it? (00080)
  let redeemedByToken = new Set<string>();
  let autoCompensated = new Set<string>();
  if (allIds.length) {
    const [{ data: redeemed }, { data: minted }] = await Promise.all([
      admin.from('make_up_tokens').select('redeemed_booking_id').in('redeemed_booking_id', allIds),
      admin
        .from('make_up_tokens')
        .select('origin_booking_id')
        .in('origin_booking_id', allIds)
        .eq('auto_issued', true),
    ]);
    redeemedByToken = new Set(
      (redeemed ?? []).map((t) => t.redeemed_booking_id).filter((id): id is string => !!id)
    );
    autoCompensated = new Set(
      (minted ?? []).map((t) => t.origin_booking_id).filter((id): id is string => !!id)
    );
  }

  const bookings = rows.map((r) => ({
    ...r,
    // What paid for this booking — drives the cancel-confirm heads-up.
    paid_with: redeemedByToken.has(r.id)
      ? 'token'
      : r.package_purchase_id
        ? 'credit'
        : r.payment_status === 'paid'
          ? 'cash'
          : 'free',
    // How a cancelled booking was made good (00080/00081) — the permanent
    // line on the card.
    compensation:
      r.status !== 'cancelled'
        ? null
        : autoCompensated.has(r.id)
          ? 'token'
          : r.package_purchase_id
            ? 'credit'
            : null,
  }));

  return NextResponse.json({ bookings });
}
