import { NextResponse } from 'next/server';
import { getStripe, GROWTH_TRIAL_DAYS } from '@/lib/stripe';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireProviderRole } from '@/lib/vendor';
import { vendorPageUrl } from '@/lib/cors';
import { PAID_PLANS, dbStatus, planLabel, type PaidPlan } from '@/lib/plans';

/**
 * Start, or move between, a paid subscription — Growth or Pro — for a provider.
 * Owner-only.
 *
 * Returns one of:
 *   { url }                  → send the browser to Stripe Checkout (first-time)
 *   { switched: true, plan }  → the existing subscription was moved in place
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
 *  - moves an existing live subscription between tiers *in place*, with
 *    proration, rather than stacking a second one;
 *  - only grants the free trial to a genuinely first-time subscriber. It used
 *    to be applied unconditionally, so every repeat checkout and every
 *    upgrade restarted a 30-day free trial — which is why all nine of those
 *    subscriptions were still `trialing` and none had ever been charged.
 *
 * Pre-existing duplicates are NOT cleaned up here — cancelling someone's
 * subscription is not a side effect a plan click should have. Use
 * `npm run stripe:dedupe` for that.
 */

/** Stripe statuses that mean "this subscription still occupies the vendor's plan slot". */
const LIVE_STATUSES = ['active', 'trialing', 'past_due', 'unpaid'];

export async function POST(request: Request) {
  const { provider_id: providerId, plan = 'growth', billing = 'monthly' } = (await request.json()) as {
    provider_id?: string;
    plan?: PaidPlan;
    billing?: 'monthly' | 'annual';
  };
  if (!providerId) {
    return NextResponse.json({ error: 'provider_id required' }, { status: 400 });
  }
  if (!PAID_PLANS.includes(plan)) {
    return NextResponse.json({ error: 'plan must be "growth" or "pro"' }, { status: 400 });
  }

  const auth = await requireProviderRole(request, providerId, 'owner');
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const admin = createAdminClient();
  const stripe = getStripe();

  // Resolve the plan's price (monthly/annual) from app_config.
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

    // Move the tier on the subscription they already have. Proration means an
    // upgrade is charged the difference now and a downgrade credits it back,
    // instead of running two subscriptions side by side.
    const item = current.items.data[0];
    const updated = await stripe.subscriptions.update(current.id, {
      items: [{ id: item.id, price: priceId }],
      proration_behavior: 'create_prorations',
      // The webhook reads `plan` off the subscription's own metadata, so it
      // has to move with the price — otherwise a switch is recorded as the
      // old tier.
      metadata: { ...current.metadata, provider_id: providerId, plan },
    });

    await admin
      .from('subscriptions')
      .update({
        plan,
        stripe_subscription_id: updated.id,
        status: dbStatus(updated.status) as never,
        cancel_at_period_end: updated.cancel_at_period_end,
      })
      .eq('provider_id', providerId);

    return NextResponse.json({
      switched: true,
      plan,
      duplicates: live.length - 1,
    });
  }

  // First paid subscription for this customer, or they cancelled and are
  // coming back. The trial is for the former only: a vendor who has already
  // had a subscription (any status, including canceled) doesn't get another
  // free month.
  const neverSubscribed = existing.data.length === 0;

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    subscription_data: {
      ...(neverSubscribed ? { trial_period_days: GROWTH_TRIAL_DAYS } : {}),
      metadata: { provider_id: providerId, plan },
    },
    metadata: { provider_id: providerId, kind: 'subscription', plan },
    success_url: vendorPageUrl(request, '/billing', 'status=success'),
    cancel_url: vendorPageUrl(request, '/billing', 'status=cancelled'),
  });

  return NextResponse.json({ url: session.url });
}
