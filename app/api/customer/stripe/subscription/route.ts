import { NextResponse } from 'next/server';
import { getStripe } from '@/lib/stripe';
import { getAuthedContext } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { appOrigin } from '@/lib/cors';

/**
 * Parent "Plus" subscription.
 *   GET  → the caller's current plan state (free/plus + status/renewal).
 *   POST → a Stripe Checkout URL to start Plus. Body: { billing?: 'monthly' | 'annual' }
 *
 * Pricing (SGD, from the Plans deck): Plus is 9/mo or 99/yr, first month free
 * (30-day trial). Prices are inlined via price_data so no pre-made Stripe Price
 * is required. GST is billed separately once Stripe Tax is configured.
 */

const PLUS_TRIAL_DAYS = 30;
// Bump when the Terms & Conditions materially change; stored alongside the
// acceptance timestamp so we know which version a user agreed to. Kept local:
// App Router route files may only export handlers + Next's config fields.
const TERMS_VERSION = '2026-07';
const PLUS_PRICING = {
  monthly: { unit_amount: 900, interval: 'month' as const, label: 'BabyBrain Plus (monthly)' },
  annual: { unit_amount: 9900, interval: 'year' as const, label: 'BabyBrain Plus (annual)' },
};

export async function GET(request: Request) {
  const { supabase, user } = await getAuthedContext(request);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const [{ data: sub }, { data: profile }] = await Promise.all([
    supabase
      .from('customer_subscriptions')
      .select('plan, billing_interval, status, current_period_end, cancel_at_period_end')
      .eq('user_id', user.id)
      .maybeSingle(),
    supabase
      .from('parent_profiles')
      .select('terms_accepted_at, terms_version')
      .eq('id', user.id)
      .maybeSingle(),
  ]);

  return NextResponse.json({
    plan: sub?.plan ?? 'free',
    billing_interval: sub?.billing_interval ?? null,
    status: sub?.status ?? null,
    current_period_end: sub?.current_period_end ?? null,
    cancel_at_period_end: sub?.cancel_at_period_end ?? false,
    terms_accepted_at: profile?.terms_accepted_at ?? null,
    terms_version: profile?.terms_version ?? null,
  });
}

export async function POST(request: Request) {
  const { billing = 'monthly' } = (await request.json().catch(() => ({}))) as {
    billing?: 'monthly' | 'annual';
  };
  const price = PLUS_PRICING[billing] ?? PLUS_PRICING.monthly;

  const { user } = await getAuthedContext(request);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const admin = createAdminClient();

  // The checkout CTA states "By subscribing you agree to our Terms &
  // Conditions" — record that explicit consent (timestamp + version).
  await admin
    .from('parent_profiles')
    .update({ terms_accepted_at: new Date().toISOString(), terms_version: TERMS_VERSION })
    .eq('id', user.id);

  // Reuse the parent's Stripe customer if we already have one.
  const { data: existing } = await admin
    .from('customer_subscriptions')
    .select('stripe_customer_id, plan')
    .eq('user_id', user.id)
    .maybeSingle();

  if (existing?.plan === 'plus') {
    return NextResponse.json({ error: 'You are already on Plus.' }, { status: 409 });
  }

  const stripe = getStripe();
  let customerId = existing?.stripe_customer_id ?? undefined;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email ?? undefined,
      metadata: { user_id: user.id },
    });
    customerId = customer.id;
  }

  // Ensure a row exists carrying the customer id (so the billing portal works
  // even before the first webhook lands). Keeps plan/status at their defaults.
  await admin
    .from('customer_subscriptions')
    .upsert(
      { user_id: user.id, stripe_customer_id: customerId, billing_interval: billing },
      { onConflict: 'user_id' }
    );

  const origin = appOrigin(request);
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [
      {
        price_data: {
          currency: 'sgd',
          unit_amount: price.unit_amount,
          recurring: { interval: price.interval },
          product_data: { name: price.label },
        },
        quantity: 1,
      },
    ],
    subscription_data: {
      trial_period_days: PLUS_TRIAL_DAYS,
      metadata: { user_id: user.id, billing },
    },
    metadata: { kind: 'customer_subscription', user_id: user.id, billing },
    success_url: `${origin}/profile?tab=settings&billing=success`,
    cancel_url: `${origin}/pricing?billing=cancelled`,
  });

  return NextResponse.json({ url: session.url });
}
