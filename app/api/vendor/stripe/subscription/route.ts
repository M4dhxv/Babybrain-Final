import { NextResponse } from 'next/server';
import { getStripe, LIVE_STATUSES } from '@/lib/stripe';
import { renewalTerms } from '@/lib/subscription-terms';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireProviderRole } from '@/lib/vendor';
import { vendorPageUrl } from '@/lib/cors';
import { stripeConfig } from '@/lib/stripe-config';
import { PAID_PLANS, planLabel, type PaidPlan } from '@/lib/plans';

/**
 * Start, move between, or cancel a paid subscription — Growth or Pro — for a
 * provider. `plan: 'free'` downgrades to the commission-only "Pay as you
 * grow" tier, i.e. cancels. Owner-only.
 *
 * Returns `{ url }` in every case — first-time subscribe, a tier switch, or a
 * downgrade-to-free cancellation all send the browser to a Stripe-hosted
 * screen. Nothing here mutates a subscription the vendor already has: only
 * Stripe's own confirmation flow does that, and only the webhook writes the
 * result to `subscriptions` once Stripe reports it.
 *
 * QA 23/08: "If you are already on the Pro plan, you shouldn't be able to get
 * to stripe payment to upgrade to the plan you are already on." The row
 * understates it. Nothing here — or on the Plans page — ever looked at the
 * provider's current plan, and Stripe does not deduplicate: every click on a
 * plan button minted *another* subscription against the same customer. The
 * demo vendor had accumulated nine live subscriptions (6 Growth + 3 Pro),
 * which at trial end would have invoiced $1,191/month. `subscriptions.plan`
 * also flip-flopped, because the webhook records whichever event landed last.
 *
 * So this route now:
 *  - refuses a checkout for the plan the vendor already holds (409);
 *  - for an existing live subscription, deep-links into the Billing Portal's
 *    `subscription_update_confirm` (tier switch) or `subscription_cancel`
 *    (downgrade to free) flow for that specific subscription, rather than
 *    calling the Subscriptions API ourselves. QA 09/09: "when changing
 *    subscription plan, you should always have to go via stripe where it
 *    notifies that payment is recurring... sometimes it just updates by
 *    clicking CTA" — that "sometimes" was every switch, since the old code
 *    called `stripe.subscriptions.update()` directly behind a
 *    `window.confirm()` and never showed Stripe's own screen at all;
 *  - only grants the free trial to a genuinely first-time subscriber. It used
 *    to be applied unconditionally, so every repeat checkout and every
 *    upgrade restarted a 30-day free trial — which is why all nine of those
 *    subscriptions were still `trialing` and none had ever been charged.
 *    (Superseded below: there is no free trial left at all, see 9fd57da.)
 *
 * Pre-existing duplicates are NOT reachable from either flow, which only
 * targets the one subscription that actually holds the vendor's plan slot
 * (the oldest live one). Use `npm run stripe:dedupe` for those.
 */

/** Stripe statuses that mean "this subscription still occupies the vendor's plan slot". */

export async function POST(request: Request) {
  const { provider_id: providerId, plan = 'growth', billing = 'monthly' } = (await request.json()) as {
    provider_id?: string;
    plan?: PaidPlan | 'free';
    billing?: 'monthly' | 'annual';
  };
  if (!providerId) {
    return NextResponse.json({ error: 'provider_id required' }, { status: 400 });
  }
  // 'free' is the commission-only "Pay as you grow" tier — it has no Stripe
  // price, so moving to it means ending the paid subscription rather than
  // switching a price. Handled below; every other value must be a paid plan.
  if (plan !== 'free' && !PAID_PLANS.includes(plan)) {
    return NextResponse.json({ error: 'plan must be "growth", "pro" or "free"' }, { status: 400 });
  }

  const auth = await requireProviderRole(request, providerId, 'owner');
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const admin = createAdminClient();
  const stripe = getStripe();

  // Downgrade to "Pay as you grow": end the paid subscription. A
  // cancellation is money stopping rather than moving, but it's still a
  // change the vendor has to confirm on Stripe's own screen, not ours — see
  // the file doc comment. `subscription_cancel` deep-links straight into the
  // portal's cancellation flow (with the reason-collection screen already
  // configured, see scripts/setup-stripe-portal.mjs) for the subscription
  // that actually holds the plan slot; the DB row is left alone here and
  // updated only once the webhook confirms the cancellation actually happened
  // — a vendor who opens the flow and backs out must not be recorded as free.
  if (plan === 'free') {
    const { data: sub } = await admin
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('provider_id', providerId)
      .maybeSingle();
    if (!sub?.stripe_customer_id) {
      return NextResponse.json({ error: 'No billing account yet' }, { status: 400 });
    }

    const existing = await stripe.subscriptions.list({
      customer: sub.stripe_customer_id,
      status: 'all',
      limit: 100,
    });
    const live = existing.data
      .filter((s) => LIVE_STATUSES.includes(s.status))
      .sort((a, b) => a.created - b.created);
    if (live.length === 0) {
      return NextResponse.json({ error: 'Nothing to cancel — already on Pay as you grow.' }, { status: 409 });
    }

    const configurationId = (await stripeConfig(admin, ['stripe_portal_configuration_id']))
      .stripe_portal_configuration_id;
    const portal = await stripe.billingPortal.sessions.create({
      customer: sub.stripe_customer_id,
      ...(configurationId ? { configuration: configurationId } : {}),
      flow_data: {
        type: 'subscription_cancel',
        subscription_cancel: { subscription: live[0].id },
        after_completion: {
          type: 'redirect',
          redirect: { return_url: vendorPageUrl(request, '/billing', 'status=cancel_returned') },
        },
      },
    });
    return NextResponse.json({ url: portal.url });
  }

  // Resolve the plan's price (monthly/annual) from app_config, preferring the
  // current Stripe mode's row — test and live price ids are not interchangeable.
  const monthlyKey = `stripe_${plan}_price_id`;
  const annualKey = `stripe_${plan}_price_id_annual`;
  const cfg = await stripeConfig(admin, [monthlyKey, annualKey]);
  const priceId = billing === 'annual' ? cfg[annualKey] : cfg[monthlyKey];
  if (!priceId) {
    return NextResponse.json(
      { error: `${planLabel(plan)} price not configured (${billing === 'annual' ? annualKey : monthlyKey} missing from app_config)` },
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

  // What does Stripe think this vendor already has? Asked of Stripe rather
  // than of our own `stripe_subscription_id`, which records only the most
  // recent one and so cannot see a stacked duplicate.
  const existing = await stripe.subscriptions.list({
    customer: customerId,
    status: 'all',
    limit: 100,
  });
  const live = existing.data
    .filter((s) => LIVE_STATUSES.includes(s.status))
    .sort((a, b) => a.created - b.created);
  const current = live[0];

  if (current) {
    const currentPrice = current.items.data[0]?.price?.id;
    if (currentPrice === priceId) {
      return NextResponse.json(
        {
          error: `You're already on the ${planLabel(plan)} plan.`,
          code: 'already_on_plan',
          plan,
        },
        { status: 409 }
      );
    }

    // Move the tier on the subscription they already have — but via Stripe's
    // own confirmation screen, not by calling the Subscriptions API directly.
    // Proration means an upgrade is charged the difference now and a
    // downgrade credits it back; `subscription_update_confirm` states that on
    // Stripe's page and requires the vendor to actually confirm it there.
    // The portal configuration already lists Growth and Pro as switchable
    // products (scripts/setup-stripe-portal.mjs); nothing here writes to
    // `subscriptions` — the webhook does that once Stripe reports the change.
    const configurationId = (await stripeConfig(admin, ['stripe_portal_configuration_id']))
      .stripe_portal_configuration_id;
    const portal = await stripe.billingPortal.sessions.create({
      customer: customerId,
      ...(configurationId ? { configuration: configurationId } : {}),
      flow_data: {
        type: 'subscription_update_confirm',
        subscription_update_confirm: {
          subscription: current.id,
          items: [{ id: current.items.data[0].id, price: priceId, quantity: 1 }],
        },
        after_completion: {
          type: 'redirect',
          redirect: { return_url: vendorPageUrl(request, '/billing', 'status=success') },
        },
      },
    });
    return NextResponse.json({ url: portal.url });
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    // No trial, deliberately: the first period is charged on sign-up on both
    // the vendor and the parent side. There used to be 30 free days here.
    subscription_data: { metadata: { provider_id: providerId, plan } },
    // Lets a vendor redeem a Stripe promotion code — how a waived or
    // discounted subscription fee is granted, rather than editing prices.
    allow_promotion_codes: true,
    // The Billing Portal cannot render arbitrary text, so the renewal and
    // commission terms are stated here, at the one point before money moves.
    custom_text: { submit: { message: renewalTerms(plan, billing) } },
    metadata: { provider_id: providerId, kind: 'subscription', plan },
    success_url: vendorPageUrl(request, '/billing', 'status=success'),
    cancel_url: vendorPageUrl(request, '/billing', 'status=cancelled'),
  });

  return NextResponse.json({ url: session.url });
}
