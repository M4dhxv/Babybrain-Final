import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getAuthedContext } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { getProviderWixCredentials } from '@/lib/wix/client';
import { checkWixBookingGates, createWixBookingAndSession, resolveWixContact } from '@/lib/wix/sync';

/**
 * Parent books a Wix-sourced slot for free (no package, no payment — see
 * app/api/wix/bookings/redeem-package for the credit-paid path). Creates
 * the booking in Wix (for `count` participants) and materializes the local
 * session via createWixBookingAndSession, then inserts `count` local
 * bookings referencing it — one per spot, so the existing capacity/waitlist
 * trigger (handle_booking_insert), which counts rows, correctly sees each
 * child as its own seat instead of the whole party as one.
 * Free means free: the price is resolved server-side and a paid class is
 * refused here (the parent's own page routes those to
 * /api/wix/bookings/checkout). The client used to be the only thing deciding
 * which of the two endpoints to call, so posting straight to this one bought
 * a paid Wix class for nothing — and, worse, took a real seat on the
 * vendor's Wix calendar to do it.
 *
 * The vendor's other booking rules (paused, cut-off, required information)
 * are applied here too. They normally live in the enforce_booking_insert_defaults
 * trigger, which deliberately steps aside for the service-role client every
 * route in this folder uses — see checkWixBookingGates.
 * Body: { activityId, wixSlotId, childId?, policiesAccepted?, medicalDisclosure?, infoResponse?, count? }
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
    infoResponse?: string;
    count?: number;
    // Names for the extra seats of a multi-child booking (00084); index 0 =
    // the 2nd child. Blank -> "Guest child".
    guestNames?: string[];
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
    .select('id, provider_id, wix_service_id, wix_resource_id, wix_service_type, price, bookings_paused, booking_cutoff_minutes, info_request_enabled')
    .eq('id', activityId)
    .maybeSingle();
  if (!activity?.wix_service_id || !activity.provider_id) {
    return NextResponse.json({ error: 'Activity is not linked to a Wix service' }, { status: 404 });
  }

  // Authoritative price from the activity, not from whichever endpoint the
  // client chose to call — the mirror image of the check
  // /api/wix/bookings/checkout makes for a free one.
  if (Number(activity.price ?? 0) > 0) {
    return NextResponse.json({ error: 'This class has to be paid for — start checkout instead' }, { status: 400 });
  }

  const gates = checkWixBookingGates(activity, body.infoResponse);
  if (!gates.ok) return NextResponse.json({ error: gates.error }, { status: gates.status });

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
    count,
    { cutoffMinutes: activity.booking_cutoff_minutes }
  );
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  // A party (00084): every seat is its own row sharing a booking_group_id
  // so the parent app collapses them into one card. Seat 1 carries the
  // child; seats 2..N are "Guest child" (renamable later) and skip the
  // medical/info fields, which ride on seat 1.
  const groupId = count > 1 ? randomUUID() : null;
  const rows = Array.from({ length: count }, (_unused, i) => ({
    user_id: user.id,
    child_id: i === 0 ? (body.childId ?? null) : null,
    guest_name: i === 0 ? null : (body.guestNames?.[i - 1]?.trim() || 'Guest child'),
    booking_group_id: groupId,
    session_id: result.sessionId,
    status: 'confirmed' as const,
    payment_status: 'none' as const,
    policies_accepted: body.policiesAccepted ?? [],
    medical_disclosure: i === 0 ? (body.medicalDisclosure || null) : null,
    // Whatever this activity asks for at booking. Collected by the parent
    // page and required by checkWixBookingGates above — it was being dropped
    // on the floor here, so a vendor who asks (e.g. "which condo are we
    // coming to?") got a roster with the answer blank.
    info_response: i === 0 ? (body.infoResponse?.trim() || null) : null,
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
