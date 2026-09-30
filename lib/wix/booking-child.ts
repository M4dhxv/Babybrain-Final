import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

export type BookingChildResult =
  | { ok: true; childId: string }
  | { ok: false; error: string; status: number };

/**
 * The child a parent's booking is for. Every parent booking belongs to one of
 * their children, so the Wix booking routes resolve it up front — before
 * anything is reserved on Wix — rather than trusting whatever `childId` the
 * request body carried (which used to be stored unchecked, and as null when
 * the parent app posted before their children had loaded: the booking then
 * showed under "Not assigned to a child").
 *
 * - No children on the account: refused, nothing to attach the booking to.
 * - A `childId` that isn't this parent's: refused (also stops attaching a
 *   booking to someone else's child).
 * - No `childId` sent: fine for a single-child account (that child), refused
 *   when there is a choice to make.
 */
export async function resolveBookingChild(
  admin: SupabaseClient<Database>,
  userId: string,
  childId: string | null | undefined
): Promise<BookingChildResult> {
  const { data: kids, error } = await admin
    .from('children')
    .select('id')
    .eq('parent_id', userId)
    .order('created_at');
  if (error) {
    console.error('Booking child lookup failed', error);
    return { ok: false, error: 'Could not check your child profile — please try again', status: 500 };
  }
  const ids = (kids ?? []).map((k) => k.id as string);
  if (ids.length === 0) {
    return { ok: false, error: "Add your child's profile before booking", status: 400 };
  }
  if (childId) {
    if (!ids.includes(childId)) {
      return { ok: false, error: 'That child is no longer on your profile — pick another', status: 400 };
    }
    return { ok: true, childId };
  }
  if (ids.length === 1) return { ok: true, childId: ids[0] };
  return { ok: false, error: 'Choose which child this booking is for', status: 400 };
}
