import { NextResponse } from 'next/server';
import { getStripe, ONE_OFF_PAYMENT_METHODS } from '@/lib/stripe';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireProviderRole } from '@/lib/vendor';
import { vendorPageUrl } from '@/lib/cors';

/**
 * One-off Checkout to buy featured/sponsored placement ("Boost") for an
 * activity. Manager+. On payment the webhook sets activities.boosted_until.
 * Body: { provider_id: string, activity_id: string, days?: number }
 */
export async function POST(request: Request) {
  const {
    provider_id: providerId,
    activity_id: activityId,
    days = 14,
  } = (await request.json()) as { provider_id?: string; activity_id?: string; days?: number };
  if (!providerId || !activityId) {
    return NextResponse.json({ error: 'provider_id and activity_id required' }, { status: 400 });
  }
  const auth = await requireProviderRole(request, providerId, 'manager');
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const admin = createAdminClient();

  // Confirm the activity belongs to this provider.
  const { data: activity } = await admin
    .from('activities')
    .select('id, title')
    .eq('id', activityId)
    .eq('provider_id', providerId)
    .maybeSingle();
  if (!activity) {
    return NextResponse.json({ error: 'Activity not found for this business' }, { status: 404 });
  }

  const { data: cfg } = await admin
    .from('app_config')
    .select('value')
    .eq('key', 'stripe_boost_amount_cents')
    .maybeSingle();
  const amountCents = Number(cfg?.value ?? 3000); // default SGD 30 / 14 days

  const session = await getStripe().checkout.sessions.create({
    mode: 'payment',
    // Boost was the one one-off checkout that never set these, so it fell back
    // to Stripe's default (card first, no GrabPay).
    payment_method_types: ONE_OFF_PAYMENT_METHODS,
    line_items: [
      {
        price_data: {
          currency: 'sgd',
          unit_amount: amountCents,
          product_data: { name: `Boost: ${activity.title} (${days} days)` },
        },
        quantity: 1,
      },
    ],
    metadata: {
      kind: 'boost',
      provider_id: providerId,
      activity_id: activityId,
      days: String(days),
    },
    success_url: vendorPageUrl(request, '/activities', 'boost=success'),
    cancel_url: vendorPageUrl(request, '/activities', 'boost=cancelled'),
  });

  return NextResponse.json({ url: session.url });
}
