import { NextResponse } from 'next/server';
import { getStripe, ONE_OFF_PAYMENT_METHODS } from '@/lib/stripe';
import { getAuthedContext } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { appOrigin } from '@/lib/cors';
import { computeSplit, getTerms } from '@/lib/commercials';

/**
 * Parent buys a class package (multi-session pack). One-off Stripe Checkout;
 * the webhook (kind='package') creates the package_purchases row with credits.
 * Body: { package_id: string, activity_session_id?: string, child_id?: string }
 *
 * activity_session_id/child_id are only present when checkout was started
 * from a specific class's booking page — QA: buying the pack there should
 * also book that class, not just grant credits. Not validated here beyond
 * shape; autoBookPackageSession re-checks the pack actually applies to that
 * session before booking anything.
 */
export async function POST(request: Request) {
  const {
    package_id: packageId,
    activity_session_id: activitySessionId,
    child_id: childId,
  } = (await request.json().catch(() => ({}))) as {
    package_id?: string;
    activity_session_id?: string;
    child_id?: string;
  };
  if (!packageId) {
    return NextResponse.json({ error: 'package_id required' }, { status: 400 });
  }

  const { user } = await getAuthedContext(request);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const admin = createAdminClient();
  const { data: pkg } = await admin
    .from('packages')
    .select('id, name, credits, price_cents, active, provider_id')
    .eq('id', packageId)
    .maybeSingle();
  if (!pkg || !pkg.active) {
    return NextResponse.json({ error: 'Package not available' }, { status: 404 });
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
      ...(activitySessionId ? { activity_session_id: activitySessionId } : {}),
      ...(childId ? { child_id: childId } : {}),
    },
    // session_id lets the app credit the pack on return even if the Stripe
    // webhook is delayed or misconfigured (see /api/stripe/reconcile).
    success_url: `${origin}/profile?tab=packages&purchase=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/profile?tab=packages&purchase=cancelled`,
  });

  return NextResponse.json({ url: session.url });
}
