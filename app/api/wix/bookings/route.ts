import { NextResponse } from 'next/server';
import { getAuthedContext } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { getProviderWixCredentials } from '@/lib/wix/client';
import { createWixBookingAndSession, resolveWixContact } from '@/lib/wix/sync';

/**
 * Parent books a Wix-sourced slot for free (no package, no payment — see
 * app/api/wix/bookings/redeem-package for the credit-paid path). Creates
 * the booking in Wix (for `count` participants) and materializes the local
 * session via createWixBookingAndSession, then inserts `count` local
 * bookings referencing it — one per spot, so the existing capacity/waitlist
 * trigger (handle_booking_insert), which counts rows, correctly sees each
 * child as its own seat instead of the whole party as one.
 * Body: { activityId, wixSlotId, childId?, policiesAccepted?, medicalDisclosure?, count? }
 */
// Every Wix API call is bounded at 20s by wixFetch, and these routes make
// several of them back to back (resolve a slot, create the booking, confirm
// it). On the platform default (~10s) a slow-but-healthy Wix response gets
// the function killed mid-flight and the user sees a bare network error —
// for credentials/bookings that were perfectly fine. Same 60s ceiling the
// other Wix routes already set.
export const maxDuration = 60;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    activityId?: string;
    wixSlotId?: string;
    childId?: string | null;
    policiesAccepted?: string[];
    medicalDisclosure?: string;
    count?: number;
  };
  const { activityId, wixSlotId } = body;
  const count = Math.min(Math.max(Math.trunc(body.count ?? 1), 1), 6);
  if (!activityId || !wixSlotId?.startsWith('wix:')) {
    return NextResponse.json({ error: 'activityId and wixSlotId required' }, { status: 400 });
  }

  const { user } = await getAuthedContext(request);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const admin = createAdminClient();
  const { data: activity } = await admin
    .from('activities')
    .select('id, provider_id, wix_service_id, wix_resource_id, wix_service_type')
    .eq('id', activityId)
    .maybeSingle();
  if (!activity?.wix_service_id || !activity.provider_id) {
    return NextResponse.json({ error: 'Activity is not linked to a Wix service' }, { status: 404 });
  }

  const creds = await getProviderWixCredentials(admin, activity.provider_id);
  if (!creds) {
    return NextResponse.json({ error: 'This business has not connected a Wix account' }, { status: 409 });
  }

  const contact = await resolveWixContact(admin, user.id);

  const result = await createWixBookingAndSession(
    admin,
    creds,
    { id: activity.id, wix_service_id: activity.wix_service_id, wix_resource_id: activity.wix_resource_id, wix_service_type: activity.wix_service_type },
    wixSlotId,
    contact,
    count
  );
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  const rows = Array.from({ length: count }, () => ({
    user_id: user.id,
    child_id: body.childId ?? null,
    session_id: result.sessionId,
    status: 'confirmed' as const,
    payment_status: 'none' as const,
    policies_accepted: body.policiesAccepted ?? [],
    medical_disclosure: body.medicalDisclosure || null,
    wix_booking_id: result.wixBookingId,
  }));
  const { data: bookings, error: bookingError } = await admin.from('bookings').insert(rows).select('id, status');
  if (bookingError || !bookings || bookings.length !== count) {
    console.error('Booked in Wix but failed to save the local booking(s)', result.wixBookingId, bookingError);
    return NextResponse.json(
      { error: 'Booked in Wix but failed to save locally — contact support' },
      { status: 500 }
    );
  }

  return NextResponse.json(bookings[0]);
}
