import { NextResponse } from 'next/server';
import { getStripe } from '@/lib/stripe';
import { getAuthedContext } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { appOrigin } from '@/lib/cors';

/**
 * Stripe Billing Portal for a parent — manage payment method, view invoices,
 * and cancel/resume the Plus subscription. Returns a hosted portal URL.
 */
export async function POST(request: Request) {
  const { user } = await getAuthedContext(request);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const admin = createAdminClient();
  const { data: sub } = await admin
    .from('customer_subscriptions')
    .select('stripe_customer_id')
    .eq('user_id', user.id)
    .maybeSingle();
  if (!sub?.stripe_customer_id) {
    return NextResponse.json({ error: 'No subscription to manage yet.' }, { status: 400 });
  }

  const origin = appOrigin(request);
  let portal;
  try {
    portal = await getStripe().billingPortal.sessions.create({
      customer: sub.stripe_customer_id,
      return_url: `${origin}/profile?tab=settings`,
    });
  } catch (e) {
    // A stored customer id that Stripe doesn't recognise — most likely a
    // test-mode `cus_` left behind by a switch to live keys, since the two
    // modes share no objects. Without this the SDK's throw escapes as a 500;
    // the parent should get the same kind of message as the no-subscription
    // case above.
    if ((e as { code?: string }).code === 'resource_missing') {
      return NextResponse.json(
        { error: 'That billing account is no longer available. Please contact support.' },
        { status: 400 },
      );
    }
    throw e;
  }
  return NextResponse.json({ url: portal.url });
}
