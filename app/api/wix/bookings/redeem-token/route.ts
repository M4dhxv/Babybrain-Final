import { NextResponse } from 'next/server';
import { getAuthedContext } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { getProviderWixCredentials } from '@/lib/wix/client';
import { createWixBookingAndSession, resolveWixContact } from '@/lib/wix/sync';

/**
 * Parent redeems a make-up token for a Wix-sourced slot.
 *
 * redeem_make_up_token (the RPC the non-Wix booking page calls directly) is
 * pure SQL — it can't reach the Wix API, and it expects an existing
 * activity_sessions row, which a Wix slot deliberately doesn't have until
 * it's actually booked. So this route does both halves in order, mirroring
 * app/api/wix/bookings/redeem-package:
 *
 *   1. Claim the token (issued -> redeemed) up front, conditionally, so a
 *      double-redeem race is lost before any real Wix booking is made.
 *   2. Create the booking in Wix and materialize the local session
 *      (createWixBookingAndSession, same as the free-booking route). If that
 *      fails, the claim is rolled back.
 *   3. Insert the local booking (free — a make-up token is "on the house")
 *      and link it back to the token.
 *
 * A make-up token is always one class for one child, so `count` is 1.
 *
 * Body: { activityId, wixSlotId, tokenId, policiesAccepted?, medicalDisclosure?, infoResponse? }
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    activityId?: string;
    wixSlotId?: string;
    tokenId?: string;
    policiesAccepted?: string[];
    medicalDisclosure?: string;
    infoResponse?: string;
  };
  const { activityId, wixSlotId, tokenId } = body;
  if (!activityId || !wixSlotId?.startsWith('wix:') || !tokenId) {
    return NextResponse.json({ error: 'activityId, wixSlotId and tokenId required' }, { status: 400 });
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

  // The token must be this parent's, live, and for this provider — checked
  // before anything is claimed or booked.
  const { data: token } = await admin
    .from('make_up_tokens')
    .select('id, provider_id, child_id, status, expires_at')
    .eq('id', tokenId)
    .eq('user_id', user.id)
    .maybeSingle();
  if (
    !token ||
    token.status !== 'issued' ||
    (token.expires_at && new Date(token.expires_at) <= new Date())
  ) {
    return NextResponse.json({ error: 'This make-up token is not available' }, { status: 409 });
  }
  if (token.provider_id !== activity.provider_id) {
    return NextResponse.json({ error: "This token can only be used for its provider's classes" }, { status: 409 });
  }

  // Claim it: only one caller wins the issued -> redeemed transition, so a
  // second tab (or a retry) can't spend the same token twice or cost a
  // second real Wix booking.
  const { data: claimed } = await admin
    .from('make_up_tokens')
    .update({ status: 'redeemed' })
    .eq('id', tokenId)
    .eq('status', 'issued')
    .select('id');
  if (!claimed || claimed.length === 0) {
    return NextResponse.json({ error: 'This make-up token is not available' }, { status: 409 });
  }

  const revertClaim = () =>
    admin
      .from('make_up_tokens')
      .update({ status: 'issued' })
      .eq('id', tokenId)
      .eq('status', 'redeemed')
      .is('redeemed_booking_id', null);

  const creds = await getProviderWixCredentials(admin, activity.provider_id);
  if (!creds) {
    await revertClaim();
    return NextResponse.json({ error: 'This business has not connected a Wix account' }, { status: 409 });
  }

  const contact = await resolveWixContact(admin, user.id);

  const result = await createWixBookingAndSession(
    admin,
    creds,
    { id: activity.id, wix_service_id: activity.wix_service_id, wix_resource_id: activity.wix_resource_id, wix_service_type: activity.wix_service_type },
    wixSlotId,
    contact,
    1
  );
  if (!result.ok) {
    await revertClaim();
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  const { data: booking, error: bookingError } = await admin
    .from('bookings')
    .insert({
      user_id: user.id,
      child_id: token.child_id,
      session_id: result.sessionId,
      status: 'confirmed' as const,
      payment_status: 'none' as const,
      policies_accepted: body.policiesAccepted ?? [],
      medical_disclosure: body.medicalDisclosure?.trim() || null,
      info_response: body.infoResponse?.trim() || null,
      wix_booking_id: result.wixBookingId,
    })
    .select('id, status')
    .single();
  if (bookingError || !booking) {
    // Booked for real in Wix and the token is spent, but the local row
    // didn't save — a human has to reconcile, same gap the free-booking
    // route has. Leaving the token 'redeemed' stops a retry double-booking.
    console.error('Booked in Wix but failed to save the make-up booking', result.wixBookingId, bookingError);
    return NextResponse.json(
      { error: 'Booked in Wix but failed to save locally — contact support' },
      { status: 500 }
    );
  }

  await admin
    .from('make_up_tokens')
    .update({ redeemed_booking_id: booking.id })
    .eq('id', tokenId);

  return NextResponse.json({ id: result.sessionId, status: booking.status ?? 'confirmed' });
}
