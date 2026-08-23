import { NextResponse } from 'next/server';
import { getStripe, GROWTH_TRIAL_DAYS } from '@/lib/stripe';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireProviderRole } from '@/lib/vendor';
import { vendorPageUrl } from '@/lib/cors';

/**
 * Start (or resume) a paid subscription — Growth or Pro — for a provider.
 * Owner-only. Returns a Stripe Checkout URL the frontend redirects to.
 * Body: { provider_id: string, plan?: 'growth' | 'pro', billing?: 'monthly' | 'annual' }
 *
 * QA: "click upgrade to growth and then start growing and it just takes me
 * back to the dashboard still on the free plan." The Plans page was sending
 * every "upgrade" click to /login regardless of whether the vendor was
 * already signed in — and the login page redirects a live session straight
 * to /dashboard, which is exactly the loop that was reported. This route
 * already existed and worked; nothing on the frontend called it.
 */
export async function POST(request: Request) {
  const { provider_id: providerId, plan = 'growth', billing = 'monthly' } = (await request.json()) as {
    provider_id?: string;
    plan?: 'growth' | 'pro';
    billing?: 'monthly' | 'annual';
  };
  if (!providerId) {
    return NextResponse.json({ error: 'provider_id required' }, { status: 400 });
  }
  if (plan !== 'growth' && plan !== 'pro') {
    return NextResponse.json({ error: 'plan must be "growth" or "pro"' }, { status: 400 });
  }

  const auth = await requireProviderRole(request, providerId, 'owner');
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const admin = createAdminClient();
  const stripe = getStripe();

  // Resolve the plan's price (monthly/annual) from app_config. Pro's keys
  // don't exist in app_config yet — this returns a clear config error rather
  // than silently falling back to Growth's price.
  const monthlyKey = `stripe_${plan}_price_id`;
  const annualKey = `stripe_${plan}_price_id_annual`;
  const { data: cfg } = await admin
    .from('app_config')
    .select('key, value')
    .in('key', [monthlyKey, annualKey]);
  const priceId =
    billing === 'annual'
      ? cfg?.find((c) => c.key === annualKey)?.value
      : cfg?.find((c) => c.key === monthlyKey)?.value;
  if (!priceId) {
    return NextResponse.json(
      { error: `${plan === 'pro' ? 'Pro' : 'Growth'} price not configured (${billing === 'annual' ? annualKey : monthlyKey} missing from app_config)` },
      { status: 500 }
    );
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
      // `plan` on the subscription's own metadata lets the webhook set the
      // right tier when it flips subscriptions.plan — without it, a Pro
      // checkout would have been recorded as Growth (see route comment).
      metadata: { provider_id: providerId, plan },
    },
    metadata: { provider_id: providerId, kind: 'subscription', plan },
    success_url: vendorPageUrl(request, '/billing', 'status=success'),
    cancel_url: vendorPageUrl(request, '/billing', 'status=cancelled'),
  });

  return NextResponse.json({ url: session.url });
}
