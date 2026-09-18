import { NextResponse } from 'next/server';
import { getStripe, LIVE_STATUSES } from '@/lib/stripe';
import { getAuthedContext } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { appOrigin } from '@/lib/cors';
import { stripeConfig } from '@/lib/stripe-config';
import { renewalTerms } from '@/lib/subscription-terms';

/**
 * Parent "Plus" subscription.
 *   GET  → the caller's current plan state (free/plus + status/renewal).
 *   POST → a Stripe Checkout URL to start Plus. Body: { billing?: 'monthly' | 'annual' }
 *
 * Pricing (SGD, from the Plans deck): Plus is 15/mo or 165/yr (raised from
 * 9/99, QA 06/09). No free period — the first period is charged on sign-up,
 * see 9fd57da. Prices are real Stripe Price objects (stripe_plus_price_id /
 * _annual in app_config) rather than inline price_data, so they show up in
 * the Stripe Dashboard's own Product catalog and can be managed from there.
 * GST is billed separately once Stripe Tax is configured.
 */

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
  // `billing_interval` is deliberately NOT written here: a parent who already
  // has Plus and asks for the other interval only changes it once they confirm
  // on Stripe (the webhook records it), so writing the request now would leave
  // this saying "annual" while Stripe still bills monthly if they back out.
  await admin
    .from('customer_subscriptions')
    .upsert({ user_id: user.id, stripe_customer_id: customerId }, { onConflict: 'user_id' });

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
    // they already have — but via Stripe's own confirmation screen, never by
    // calling the Subscriptions API from here. That call changed what the
    // parent pays on a single click, with no screen saying the new price
    // renews until cancelled (QA 09/09: "when changing subscription plan,
    // you should always have to go via stripe where it notifies that payment
    // is recurring... sometimes it just updates by clicking CTA"), and the
    // caller got `{ switched: true }` with no `url`, which the pages read as
    // a failed checkout. The vendor route was fixed the same way; this one
    // was missed.
    //
    // `subscription_update_confirm` needs the parent portal configuration
    // (Plus monthly ⇄ annual, from `npm run stripe:portal`) — Stripe's default
    // one has `subscription_update` disabled. If it isn't set up we refuse
    // rather than fall back to a silent update. Nothing is written to
    // `customer_subscriptions` here: the webhook does that once Stripe
    // reports the change, reading the interval off the new price.
    const parentConfigurationId = (await stripeConfig(admin, ['stripe_parent_portal_configuration_id']))
      .stripe_parent_portal_configuration_id;
    if (!parentConfigurationId) {
      return NextResponse.json(
        { error: "Switching your billing period isn't available right now. Please contact support." },
        { status: 500 }
      );
    }

    const origin = appOrigin(request);
    try {
      const portal = await stripe.billingPortal.sessions.create({
        customer: customerId,
        configuration: parentConfigurationId,
        flow_data: {
          type: 'subscription_update_confirm',
          subscription_update_confirm: {
            subscription: current.id,
            items: [{ id: current.items.data[0].id, price: priceId, quantity: 1 }],
          },
          after_completion: {
            type: 'redirect',
            redirect: { return_url: `${origin}/profile?tab=settings&billing=switched` },
          },
        },
      });
      return NextResponse.json({ url: portal.url });
    } catch (e) {
      // The configuration only lists the current Plus prices, so a
      // subscription still on an older inline price (from before the Product
      // catalog) is one Stripe won't let the portal switch. A readable message
      // beats a bare 500 — support can move that one by hand.
      console.error('[customer subscription] portal switch failed', (e as Error).message);
      return NextResponse.json(
        { error: "We couldn't open the plan change screen for your subscription. Please contact support." },
        { status: 400 }
      );
    }
  }

  // A brand-new subscription: record the interval being bought, as the ensure-
  // row write above used to.
  await admin.from('customer_subscriptions').update({ billing_interval: billing }).eq('user_id', user.id);

  const origin = appOrigin(request);
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    // No trial, deliberately: the first period is charged on sign-up. There
    // used to be 30 free days here.
    subscription_data: { metadata: { user_id: user.id, billing } },
    // Lets a parent redeem a Stripe promotion code (how a waived fee is given).
    allow_promotion_codes: true,
    // The Billing Portal cannot render arbitrary text, so the renewal terms
    // are stated here, at the one point before money moves.
    custom_text: { submit: { message: renewalTerms('plus', billing) } },
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
