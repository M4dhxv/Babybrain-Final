import { NextResponse } from 'next/server';
import { getStripe } from '@/lib/stripe';
import { getAuthedContext } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { appOrigin } from '@/lib/cors';

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
    .select('id, name, credits, price_cents, active')
    .eq('id', packageId)
    .maybeSingle();
  if (!pkg || !pkg.active) {
    return NextResponse.json({ error: 'Package not available' }, { status: 404 });
  }

  const origin = appOrigin(request);
  const session = await getStripe().checkout.sessions.create({
    mode: 'payment',
    // PayNow first, then card (which also offers Apple Pay / Google Pay).
    payment_method_types: ['paynow', 'card', 'grabpay'],
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
