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
      'id, status, created_at, child_id, package_purchase_id, activity_sessions(starts_at, ends_at, activity_id, activities(title, slug, image_urls, address, allow_cancellation, allow_rescheduling, cancellation_cutoff_hours, reschedule_cutoff_hours, wix_removed_at, wix_missing_since))'
    )
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = data ?? [];

  // How a cancelled booking was compensated (see migration 00080's
  // compensate_cancelled_booking trigger), so My Bookings can say so on the
  // card: an auto-issued make-up token points back here via
  // origin_booking_id; failing that, a package-credit booking had its credit
  // put back.
  const cancelledIds = rows.filter((r) => r.status === 'cancelled').map((r) => r.id);
  let tokenBookingIds = new Set<string>();
  if (cancelledIds.length) {
    const { data: toks } = await admin
      .from('make_up_tokens')
      .select('origin_booking_id')
      .in('origin_booking_id', cancelledIds)
      .eq('auto_issued', true);
    tokenBookingIds = new Set(
      (toks ?? []).map((t) => t.origin_booking_id).filter((id): id is string => !!id)
    );
  }

  const bookings = rows.map((r) => ({
    ...r,
    compensation:
      r.status !== 'cancelled'
        ? null
        : tokenBookingIds.has(r.id)
          ? 'token'
          : r.package_purchase_id
            ? 'credit'
            : null,
  }));

  return NextResponse.json({ bookings });
}
