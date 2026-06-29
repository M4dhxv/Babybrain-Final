import { NextResponse } from 'next/server';
import { getStripe, GROWTH_TRIAL_DAYS } from '@/lib/stripe';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireProviderRole } from '@/lib/vendor';

/**
 * Start (or resume) the Growth subscription for a provider.
 * Owner-only. Returns a Stripe Checkout URL the frontend redirects to.
 * Body: { provider_id: string, billing?: 'monthly' | 'annual' }
 */
export async function POST(request: Request) {
  const { provider_id: providerId, billing = 'monthly' } = (await request.json()) as {
    provider_id?: string;
    billing?: 'monthly' | 'annual';
  };
  if (!providerId) {
    return NextResponse.json({ error: 'provider_id required' }, { status: 400 });
  }

  const auth = await requireProviderRole(providerId, 'owner');
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const admin = createAdminClient();
  const stripe = getStripe();
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

  // Resolve the Growth price (monthly/annual) from app_config.
  const { data: cfg } = await admin
    .from('app_config')
    .select('key, value')
    .in('key', ['stripe_growth_price_id', 'stripe_growth_price_id_annual']);
  const priceId =
    billing === 'annual'
      ? cfg?.find((c) => c.key === 'stripe_growth_price_id_annual')?.value
      : cfg?.find((c) => c.key === 'stripe_growth_price_id')?.value;
  if (!priceId) {
    return NextResponse.json({ error: 'Growth price not configured' }, { status: 500 });
  }

  // Reuse the provider's Stripe customer if it exists.
  const { data: sub } = await admin
    .from('subscriptions')
    .select('stripe_customer_id')
    .eq('provider_id', providerId)
    .maybeSingle();
  const { data: provider } = await admin
    .from('providers')
    .select('business_name, contact_email')
    .eq('id', providerId)
    .single();

  let customerId = sub?.stripe_customer_id ?? undefined;
  if (!customerId) {
    const customer = await stripe.customers.create({
      name: provider?.business_name,
      email: provider?.contact_email ?? undefined,
      metadata: { provider_id: providerId },
    });
    customerId = customer.id;
    await admin
      .from('subscriptions')
      .update({ stripe_customer_id: customerId })
      .eq('provider_id', providerId);
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    subscription_data: {
      trial_period_days: GROWTH_TRIAL_DAYS,
      metadata: { provider_id: providerId },
    },
    metadata: { provider_id: providerId, kind: 'subscription' },
    success_url: `${appUrl}/vendor/billing?status=success`,
    cancel_url: `${appUrl}/vendor/billing?status=cancelled`,
  });

  return NextResponse.json({ url: session.url });
}
