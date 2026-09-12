import { NextResponse } from 'next/server';
import { getStripe, LIVE_STATUSES, periodEndIso } from '@/lib/stripe';
import { getAuthedContext } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { appOrigin } from '@/lib/cors';
import { dbStatus } from '@/lib/plans';
import { stripeConfig } from '@/lib/stripe-config';

/**
 * Parent "Plus" subscription.
 *   GET  → the caller's current plan state (free/plus + status/renewal).
 *   POST → a Stripe Checkout URL to start Plus. Body: { billing?: 'monthly' | 'annual' }
 *
 * Pricing (SGD, from the Plans deck): Plus is 9/mo or 99/yr, first month free
 * (30-day trial). Prices are real Stripe Price objects (stripe_plus_price_id /
 * _annual in app_config) rather than inline price_data, so they show up in
 * the Stripe Dashboard's own Product catalog and can be managed from there.
 * GST is billed separately once Stripe Tax is configured.
 */

const PLUS_TRIAL_DAYS = 30;
// Bump when the Terms & Conditions materially change; stored alongside the
// acceptance timestamp so we know which version a user agreed to. Kept local:
// App Router route files may only export handlers + Next's config fields.
const TERMS_VERSION = '2026-07';

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

  const { user } = await getAuthedContext(request);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const admin = createAdminClient();

  const priceKey = billing === 'annual' ? 'stripe_plus_price_id_annual' : 'stripe_plus_price_id';
  const priceId = (await stripeConfig(admin, [priceKey]))[priceKey];
  if (!priceId) {
    return NextResponse.json({ error: `Plus price not configured (${priceKey} missing from app_config)` }, { status: 500 });
  }

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

  // What does Stripe think this parent already has? Asked of Stripe rather
  // than of `customer_subscriptions.plan`, which is only written once the
  // webhook lands: guarding on the local plan let a second click during that
  // window mint a second subscription, and the parent side never got the
  // anti-stacking fix the vendor route did (one test parent had four live at
  // once). `stripe_subscription_id` is no help either — it records only the
  // most recent one, so it cannot see a stacked duplicate.
  const existingSubs = await stripe.subscriptions.list({
    customer: customerId,
    status: 'all',
    limit: 100,
  });
  const live = existingSubs.data
    .filter((s) => LIVE_STATUSES.includes(s.status))
    .sort((a, b) => a.created - b.created);
  const current = live[0];

  if (current) {
    if (current.items.data[0]?.price?.id === priceId) {
      return NextResponse.json(
        { error: 'You are already on Plus.', code: 'already_on_plan', billing },
        { status: 409 }
      );
    }

    // Same Plus tier, different billing interval (or a legacy inline price
    // from before the Product catalog existed). Move it on the subscription
    // they already have: a 409 here was a dead end, because the parent
    // billing portal runs on Stripe's default configuration where
    // `subscription_update` is disabled, so monthly ⇄ annual was impossible
    // from either side.
    const item = current.items.data[0];
    const updated = await stripe.subscriptions.update(current.id, {
      items: [{ id: item.id, price: priceId }],
      proration_behavior: 'create_prorations',
      metadata: { ...current.metadata, user_id: user.id, billing },
    });

    await admin
      .from('customer_subscriptions')
      .update({
        plan: 'plus',
        billing_interval: billing,
        stripe_subscription_id: updated.id,
        status: dbStatus(updated.status) as never,
        current_period_end: periodEndIso(updated),
        cancel_at_period_end: updated.cancel_at_period_end,
      })
      .eq('user_id', user.id);

    return NextResponse.json({ switched: true, billing, duplicates: live.length - 1 });
  }

  // First Plus subscription for this parent, or they cancelled and are coming
  // back. The trial is for the former only: `trial_period_days` was passed
  // unconditionally, so cancel → resubscribe handed out another free 30 days
  // every time, indefinitely. Mirrors the vendor route's `neverSubscribed`.
  const neverSubscribed = existingSubs.data.length === 0;

  const origin = appOrigin(request);
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    subscription_data: {
      ...(neverSubscribed ? { trial_period_days: PLUS_TRIAL_DAYS } : {}),
      metadata: { user_id: user.id, billing },
    },
    metadata: { kind: 'customer_subscription', user_id: user.id, billing },
    // Payment methods are whatever is enabled in the Stripe Dashboard and is
    // eligible for recurring SGD charges. PayNow is single-use and can't
    // auto-renew, so Plus is card/wallet only — one-off booking and package
    // checkouts do offer PayNow first.
    //
    // session_id lets the app flip the plan on return even if the Stripe
    // webhook is delayed or misconfigured (see /api/stripe/reconcile).
    success_url: `${origin}/profile?tab=settings&billing=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/pricing?billing=cancelled`,
  });

  return NextResponse.json({ url: session.url });
}
