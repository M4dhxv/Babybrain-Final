import { NextResponse } from 'next/server';
import { getAuthedContext } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { getProviderWixCredentials } from '@/lib/wix/client';
import { checkWixBookingGates, isWixSessionPaused, getWixSessionBookingCutoff, createWixBookingAndSession, resolveWixContact } from '@/lib/wix/sync';

/**
 * Last-resort recovery for when the real Wix booking succeeded but
 * redeem_package_credit then failed (most commonly its weekday/time
 * restriction check — the one validation that can't be done in this route's
 * own pre-check, see the file-level doc above). Before this existed, that
 * failure left a real Wix reservation with NO local `bookings` row at all:
 * the class's remaining capacity dropped (Wix truth, read live), the vendor
 * saw the booking on Wix's own calendar, but the parent's "My Bookings"
 * never got a row to show, and support had to reconcile it by hand.
 *
 * This inserts the same rows the RPC would have, straight through the admin
 * client (enforce_booking_insert_defaults steps aside for service_role, same
 * as redeem-token's insert; handle_booking_insert's capacity/waitlist logic
 * still runs normally). Deliberately permissive rather than re-validating —
 * the Wix seat is already spent, so the only thing left to decide is whether
 * BabyBrain's own bookkeeping can keep up, not whether the booking should
 * exist. The credit decrement is best-effort and never blocks the booking
 * from being saved.
 */
async function insertFallbackPackageBookings(
  admin: SupabaseClient<Database>,
  params: {
    userId: string;
    sessionId: string;
    wixBookingId: string;
    packagePurchaseId: string;
    childId?: string | null;
    policiesAccepted: string[];
    medicalDisclosure?: string;
    infoResponse?: string;
    guestNames: string[];
    count: number;
    purchase: { credits_remaining: number; status: 'active' | 'used' | 'expired' };
  }
): Promise<{ ok: true; status: string; waitlistedCount: number } | { ok: false }> {
  let childId: string | null = null;
  if (params.childId) {
    const { data: child } = await admin
      .from('children')
      .select('id')
      .eq('id', params.childId)
      .eq('parent_id', params.userId)
      .maybeSingle();
    childId = child?.id ?? null;
  } else {
    const { data: child } = await admin
      .from('children')
      .select('id')
      .eq('parent_id', params.userId)
      .order('created_at')
      .limit(1)
      .maybeSingle();
    childId = child?.id ?? null;
  }

  const groupId = params.count > 1 ? crypto.randomUUID() : null;
  const rows = Array.from({ length: params.count }, (_, i) => ({
    user_id: params.userId,
    session_id: params.sessionId,
    child_id: i === 0 ? childId : null,
    guest_name: i === 0 ? null : (params.guestNames[i - 1]?.trim() || 'Guest child'),
    package_purchase_id: params.packagePurchaseId,
    policies_accepted: params.policiesAccepted,
    wix_booking_id: params.wixBookingId,
    medical_disclosure: i === 0 ? params.medicalDisclosure?.trim() || null : null,
    info_response: i === 0 ? params.infoResponse?.trim() || null : null,
    booking_group_id: groupId,
    status: 'confirmed' as const,
    payment_status: 'none' as const,
  }));

  const { data: inserted, error } = await admin.from('bookings').insert(rows).select('status');
  if (error || !inserted) {
    console.error('Fallback package-credit booking insert also failed after a real Wix booking', params.wixBookingId, error);
    return { ok: false };
  }

  const waitlistedCount = inserted.filter((r) => r.status === 'waitlisted').length;
  const anyConfirmed = inserted.some((r) => r.status !== 'waitlisted');

  const newCredits = params.purchase.credits_remaining - params.count;
  const { error: creditError } = await admin
    .from('package_purchases')
    .update({ credits_remaining: newCredits, status: newCredits <= 0 ? 'used' : params.purchase.status })
    .eq('id', params.packagePurchaseId)
    .gte('credits_remaining', params.count);
  if (creditError) {
    // The booking is saved either way (top priority) — a credit that
    // couldn't be decremented is a billing follow-up, not a lost booking.
    console.error('Fallback booking saved but credit could not be decremented', params.packagePurchaseId, creditError);
  }

  return { ok: true, status: anyConfirmed ? 'confirmed' : 'waitlisted', waitlistedCount };
}

/**
 * Parent redeems a package credit for a Wix-sourced slot. redeem_package_credit
 * (the RPC the non-Wix booking page calls directly) is pure SQL — it can't
 * reach the Wix API, and it expects an existing activity_sessions row, which
 * a Wix slot deliberately doesn't have until the moment it's actually
 * booked. So this route does both halves in order: create the real booking
 * in Wix and materialize the session (createWixBookingAndSession, same as
 * the free-booking route), THEN call the same RPC — now with a real session
 * id — so credit validation, the decrement, and the local booking insert
 * all still happen through that one already-reviewed, atomic function.
 *
 * The RPC call must run on the CALLER's own (RLS-scoped) client, not the
 * admin client — it reads `auth.uid()` internally to resolve which user is
 * redeeming, which is unset on a service-role connection.
 *
 * A pre-check runs first (purchase belongs to this user, active, has
 * credits, matches this provider/activity) so an obviously-invalid credit
 * never costs a real Wix booking. It can't check the package's optional
 * weekday/time restriction ahead of time for a CLASS slot — Wix only
 * reveals a class occurrence's actual time once fetched, and that only
 * happens inside createWixBookingAndSession — so that specific restriction
 * is still enforced, just by the final RPC call rather than the pre-check.
 *
 * `count` is the number of children/spots this one credit-purchase should
 * cover — 1 credit is spent per spot, and the Wix booking itself is made
 * for that many participants (a CLASS has real seats to spare; an
 * APPOINTMENT is 1:1 and createWixBookingAndSession rejects count > 1
 * for those before ever touching Wix).
 *
 * Body: { activityId, wixSlotId, packagePurchaseId, childId?, policiesAccepted?, count?, medicalDisclosure?, infoResponse? }
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
    packagePurchaseId?: string;
    childId?: string | null;
    policiesAccepted?: string[];
    count?: number;
    medicalDisclosure?: string;
    infoResponse?: string;
    // Names for the extra seats of a multi-child booking (00084).
    guestNames?: string[];
  };
  const { activityId, wixSlotId, packagePurchaseId } = body;
  const count = Math.min(Math.max(Math.trunc(body.count ?? 1), 1), 6);
  if (!activityId || !wixSlotId?.startsWith('wix:') || !packagePurchaseId) {
    return NextResponse.json({ error: 'activityId, wixSlotId and packagePurchaseId required' }, { status: 400 });
  }

  const { supabase, user } = await getAuthedContext(request);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const admin = createAdminClient();
  const { data: activity } = await admin
    .from('activities')
    .select('id, provider_id, wix_service_id, wix_resource_id, wix_service_type, bookings_paused, booking_cutoff_minutes, info_request_enabled')
    .eq('id', activityId)
    .maybeSingle();
  if (!activity?.wix_service_id || !activity.provider_id) {
    return NextResponse.json({ error: 'Activity is not linked to a Wix service' }, { status: 404 });
  }

  // Paused / required-information up front. The RPC below runs on the
  // parent's own client, so enforce_booking_insert_defaults does apply to it
  // — but only after a real Wix booking has already been made, leaving the
  // "booked in Wix but could not redeem the credit" state below. Checking
  // here means a paused class or a missing answer costs nothing.
  const gates = checkWixBookingGates(activity, body.infoResponse);
  if (!gates.ok) return NextResponse.json({ error: gates.error }, { status: gates.status });

  if (await isWixSessionPaused(admin, activity.id, wixSlotId!)) {
    return NextResponse.json(
      { error: 'Bookings for this session are currently paused — other dates may still be available.' },
      { status: 409 }
    );
  }

  // Fail fast on an obviously-unusable credit before ever touching Wix.
  const { data: purchase } = await admin
    .from('package_purchases')
    .select('id, provider_id, status, credits_remaining, expires_at, packages(activity_ids)')
    .eq('id', packagePurchaseId)
    .eq('user_id', user.id)
    .maybeSingle();
  if (!purchase || purchase.status !== 'active' || purchase.credits_remaining < count ||
      (purchase.expires_at && new Date(purchase.expires_at) <= new Date())) {
    // Several distinct causes collapse into this one check (wrong owner,
    // inactive, too few credits, expired) — don't guess which one it was.
    return NextResponse.json({ error: 'You are not able to use this package to book this class.' }, { status: 409 });
  }
  if (purchase.provider_id !== activity.provider_id) {
    return NextResponse.json({ error: "This package can only be used for its provider's classes" }, { status: 409 });
  }
  const pkgActivityIds = (purchase.packages as unknown as { activity_ids: string[] | null } | null)?.activity_ids;
  if (pkgActivityIds && pkgActivityIds.length > 0 && !pkgActivityIds.includes(activityId)) {
    return NextResponse.json({ error: 'This package is limited to specific classes' }, { status: 409 });
  }

  const creds = await getProviderWixCredentials(admin, activity.provider_id);
  if (!creds) {
    return NextResponse.json({ error: 'This business has not connected a Wix account' }, { status: 409 });
  }

  const contact = await resolveWixContact(admin, user.id);

  // A session-level override (migration 00137) wins over the activity's
  // default; null (no row yet, or no override on it) falls back.
  const sessionCutoff = await getWixSessionBookingCutoff(admin, activity.id, wixSlotId!);

  const result = await createWixBookingAndSession(
    admin,
    creds,
    { id: activity.id, wix_service_id: activity.wix_service_id, wix_resource_id: activity.wix_resource_id, wix_service_type: activity.wix_service_type },
    wixSlotId,
    contact,
    count,
    { cutoffMinutes: sessionCutoff ?? activity.booking_cutoff_minutes }
  );
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  // The RPC re-validates everything (including the weekday/time restriction
  // the pre-check above couldn't) atomically with the credit decrement and
  // booking insert — one row per spot, all against the one real Wix booking
  // made for `count` participants. On the caller's own client so auth.uid()
  // resolves.
  const { data: redeemed, error } = await supabase
    .rpc('redeem_package_credit', {
      p_purchase_id: packagePurchaseId,
      p_session_id: result.sessionId,
      p_child_id: body.childId ?? undefined,
      p_policies: body.policiesAccepted ?? [],
      p_wix_booking_id: result.wixBookingId,
      p_quantity: count,
      p_medical: body.medicalDisclosure?.trim() || undefined,
      p_info: body.infoResponse?.trim() || undefined,
      p_guest_names: count > 1 ? (body.guestNames ?? []).map((n) => n?.trim() ?? '') : undefined,
    })
    .single();
  if (error) {
    // Booked for real in Wix, but the credit didn't redeem — a genuine race
    // (or the weekday/time restriction) rather than the common case the
    // pre-check already covers. No cancel-in-Wix capability exists yet, so
    // rather than leaving a real Wix seat with no local trace, fall back to
    // saving the booking directly (see insertFallbackPackageBookings) so it
    // still shows up under the parent's bookings; only the rare double
    // failure below still needs a human.
    console.error('Booked in Wix but redeem_package_credit failed; falling back to a direct insert', result.wixBookingId, error);
    const fallback = await insertFallbackPackageBookings(admin, {
      userId: user.id,
      sessionId: result.sessionId,
      wixBookingId: result.wixBookingId,
      packagePurchaseId: packagePurchaseId!,
      childId: body.childId,
      policiesAccepted: body.policiesAccepted ?? [],
      medicalDisclosure: body.medicalDisclosure,
      infoResponse: body.infoResponse,
      guestNames: body.guestNames ?? [],
      count,
      purchase: { credits_remaining: purchase.credits_remaining, status: purchase.status },
    });
    if (!fallback.ok) {
      return NextResponse.json(
        { error: 'Booked in Wix but could not redeem the credit — contact support' },
        { status: 500 }
      );
    }
    return NextResponse.json({ id: result.sessionId, status: fallback.status, waitlistedCount: fallback.waitlistedCount });
  }

  return NextResponse.json({
    id: result.sessionId,
    status: redeemed?.status ?? 'confirmed',
    // A CLASS slot can straddle capacity across `count` seats (00136) — the
    // seats that fit are confirmed, this many are on the local waitlist.
    waitlistedCount: redeemed?.waitlisted_count ?? 0,
  });
}
