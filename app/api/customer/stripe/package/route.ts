import { NextResponse } from 'next/server';
import { getStripe, ONE_OFF_PAYMENT_METHODS } from '@/lib/stripe';
import { getAuthedContext } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { appOrigin } from '@/lib/cors';
import { computeSplit, getTerms } from '@/lib/commercials';

/**
 * Parent buys a class package (multi-session pack). One-off Stripe Checkout;
 * the webhook (kind='package') creates the package_purchases row with
 * credits, and — when a session was chosen — atomically books it too (see
 * purchase_package_and_book, migration 00162).
 * Body: { package_id: string, activity_session_id?: string, child_id?: string,
 *   quantity?: number, guest_names?: string[], policies_accepted?: string[],
 *   medical_disclosure?: string, info_response?: string }
 *
 * activity_session_id/child_id/quantity/etc. are only present when checkout
 * was started from a specific class's booking page — QA: buying the pack
 * there should also book that class (for the whole party, not just one
 * seat), not just grant credits. The booking-page UI now requires a chosen
 * slot before it will call this at all; quantity is still capped and
 * cross-checked against the pack's own credit total here as a second line of
 * defense against a stale or bypassed client.
 */
export async function POST(request: Request) {
  const {
    package_id: packageId,
    activity_session_id: activitySessionId,
    child_id: childId,
    quantity: rawQuantity,
    guest_names: guestNames,
    policies_accepted: policiesAccepted,
    medical_disclosure: medicalDisclosure,
    info_response: infoResponse,
  } = (await request.json().catch(() => ({}))) as {
    package_id?: string;
    activity_session_id?: string;
    child_id?: string;
    quantity?: number;
    guest_names?: string[];
    policies_accepted?: string[];
    medical_disclosure?: string;
    info_response?: string;
  };
  if (!packageId) {
    return NextResponse.json({ error: 'package_id required' }, { status: 400 });
  }
  // Only meaningful alongside a session to book; capped well above any real
  // party size so a bad value can't blow up the booking loop or Stripe
  // metadata size.
  const quantity = Math.min(Math.max(1, Math.trunc(Number(rawQuantity) || 1)), 20);

  const { user } = await getAuthedContext(request);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const admin = createAdminClient();
  const { data: pkg } = await admin
    .from('packages')
    .select('id, name, credits, price_cents, active, provider_id, starts_at, expiry_date')
    .eq('id', packageId)
    .maybeSingle();
  if (!pkg || !pkg.active) {
    return NextResponse.json({ error: 'Package not available' }, { status: 404 });
  }
  // Vendor-scheduled pack: not yet on sale, or past its fixed expiry date
  // (00134/00132) — the browse UI already hides these, this is the
  // checkout-can't-be-bypassed backstop.
  const now = new Date();
  if (pkg.starts_at && new Date(pkg.starts_at) > now) {
    return NextResponse.json({ error: 'Package not available yet' }, { status: 404 });
  }
  if (pkg.expiry_date && new Date(`${pkg.expiry_date}T23:59:59+08:00`) <= now) {
    return NextResponse.json({ error: 'Package not available' }, { status: 404 });
  }
  // A pack that can't cover the whole party shouldn't be paid for at all —
  // the booking-page UI already blocks this before calling here, this is the
  // checkout-can't-be-bypassed backstop (same idea as the on-sale checks
  // above).
  if (activitySessionId && quantity > pkg.credits) {
    return NextResponse.json(
      { error: `This pack only has ${pkg.credits} credit${pkg.credits === 1 ? '' : 's'} — not enough for ${quantity} children.` },
      { status: 400 }
    );
  }

  const origin = appOrigin(request);

  // Class packs are vendor revenue, but this checkout never split them: the
  // whole purchase landed on the platform account with nothing transferred to
  // the provider. Split it the same way a booking is split, unless the
  // vendor's terms exempt packages.
  let connect = {};
  const { data: provider } = await admin
    .from('providers')
    .select('stripe_account_id, payouts_enabled')
    .eq('id', pkg.provider_id)
    .maybeSingle();
  if (provider?.stripe_account_id && provider.payouts_enabled) {
    const terms = await getTerms(admin, pkg.provider_id);
    const split = terms.commissionOnPackages
      ? computeSplit(pkg.price_cents, terms)
      : computeSplit(pkg.price_cents, { ...terms, commissionRate: 0, commissionFlatCents: 0 });
    connect = {
      payment_intent_data: {
        application_fee_amount: split.applicationFeeCents,
        transfer_data: { destination: provider.stripe_account_id },
      },
    };
  }

  const session = await getStripe().checkout.sessions.create({
    mode: 'payment',
    ...connect,
    payment_method_types: ONE_OFF_PAYMENT_METHODS,
    line_items: [
      {
        price_data: {
          currency: 'sgd',
          unit_amount: pkg.price_cents,
          product_data: { name: `${pkg.name} (${pkg.credits} classes)` },
        },
        quantity: 1,
      },
    ],
    metadata: {
      kind: 'package',
      user_id: user.id,
      package_id: pkg.id,
      // The rest only matter alongside a session to book — no point
      // shipping booking paperwork for a pack bought with no class attached.
      ...(activitySessionId
        ? {
            activity_session_id: activitySessionId,
            quantity: String(quantity),
            ...(childId ? { child_id: childId } : {}),
            ...(guestNames && guestNames.length
              ? { guest_names: JSON.stringify(guestNames.slice(0, 19).map((n) => String(n).slice(0, 80))) }
              : {}),
            ...(policiesAccepted && policiesAccepted.length
              ? { policies_accepted: JSON.stringify(policiesAccepted.slice(0, 50)) }
              : {}),
            ...(medicalDisclosure?.trim() ? { medical_disclosure: medicalDisclosure.trim().slice(0, 450) } : {}),
            ...(infoResponse?.trim() ? { info_response: infoResponse.trim().slice(0, 450) } : {}),
          }
        : {}),
    },
    // session_id lets the app credit the pack on return even if the Stripe
    // webhook is delayed or misconfigured (see /api/stripe/reconcile).
    success_url: `${origin}/profile?tab=packages&purchase=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/profile?tab=packages&purchase=cancelled`,
  });

  return NextResponse.json({ url: session.url });
}
