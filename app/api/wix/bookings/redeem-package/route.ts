import { NextResponse } from 'next/server';
import { getAuthedContext } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { getProviderWixCredentials } from '@/lib/wix/client';
import { createWixBookingAndSession } from '@/lib/wix/sync';

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
 * Body: { activityId, wixSlotId, packagePurchaseId, childId?, policiesAccepted? }
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    activityId?: string;
    wixSlotId?: string;
    packagePurchaseId?: string;
    childId?: string | null;
    policiesAccepted?: string[];
  };
  const { activityId, wixSlotId, packagePurchaseId } = body;
  if (!activityId || !wixSlotId?.startsWith('wix:') || !packagePurchaseId) {
    return NextResponse.json({ error: 'activityId, wixSlotId and packagePurchaseId required' }, { status: 400 });
  }

  const { supabase, user } = await getAuthedContext(request);
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

  // Fail fast on an obviously-unusable credit before ever touching Wix.
  const { data: purchase } = await admin
    .from('package_purchases')
    .select('id, provider_id, status, credits_remaining, expires_at, packages(activity_id)')
    .eq('id', packagePurchaseId)
    .eq('user_id', user.id)
    .maybeSingle();
  if (!purchase || purchase.status !== 'active' || purchase.credits_remaining <= 0 ||
      (purchase.expires_at && new Date(purchase.expires_at) <= new Date())) {
    return NextResponse.json({ error: 'No credits available on this package (it may have expired)' }, { status: 409 });
  }
  if (purchase.provider_id !== activity.provider_id) {
    return NextResponse.json({ error: "This package can only be used for its provider's classes" }, { status: 409 });
  }
  const pkgActivityId = (purchase.packages as unknown as { activity_id: string | null } | null)?.activity_id;
  if (pkgActivityId && pkgActivityId !== activityId) {
    return NextResponse.json({ error: 'This package is limited to a specific class' }, { status: 409 });
  }

  const creds = await getProviderWixCredentials(admin, activity.provider_id);
  if (!creds) {
    return NextResponse.json({ error: 'This business has not connected a Wix account' }, { status: 409 });
  }

  const { data: parent } = await admin
    .from('parent_profiles')
    .select('full_name, email, phone')
    .eq('id', user.id)
    .maybeSingle();
  const [firstName, ...rest] = (parent?.full_name || user.email || 'Parent').trim().split(/\s+/);
  const contact = {
    firstName: firstName || 'Parent',
    lastName: rest.join(' ') || '-',
    email: parent?.email || user.email || '',
    phone: parent?.phone || '',
  };

  const result = await createWixBookingAndSession(
    admin,
    creds,
    { id: activity.id, wix_service_id: activity.wix_service_id, wix_resource_id: activity.wix_resource_id, wix_service_type: activity.wix_service_type },
    wixSlotId,
    contact
  );
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  // The RPC re-validates everything (including the weekday/time restriction
  // the pre-check above couldn't) atomically with the credit decrement and
  // booking insert. On the caller's own client so auth.uid() resolves.
  const { data: status, error } = await supabase.rpc('redeem_package_credit', {
    p_purchase_id: packagePurchaseId,
    p_session_id: result.sessionId,
    p_child_id: body.childId ?? undefined,
    p_policies: body.policiesAccepted ?? [],
    p_wix_booking_id: result.wixBookingId,
  });
  if (error) {
    // Booked for real in Wix, but the credit didn't redeem — a genuine race
    // (or the weekday/time restriction) rather than the common case the
    // pre-check already covers. No cancel-in-Wix capability exists yet, so
    // this needs a human, same as the free-booking route's equivalent gap.
    console.error('Booked in Wix but redeem_package_credit failed', result.wixBookingId, error);
    return NextResponse.json(
      { error: 'Booked in Wix but could not redeem the credit — contact support' },
      { status: 500 }
    );
  }

  return NextResponse.json({ id: result.sessionId, status: status ?? 'confirmed' });
}
