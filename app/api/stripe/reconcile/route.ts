import { NextResponse } from 'next/server';
import { getStripe } from '@/lib/stripe';
import { getAuthedContext } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { autoBookPackageSession } from '@/lib/stripe-package-auto-book';

/**
 * Apply the effect of a completed Stripe Checkout Session on return from
 * Checkout, without waiting for the webhook.
 *
 * QA found parents landing back on the site with a Plus subscription that
 * still read "Free", and a purchased class pack that never appeared under
 * Packages — both because the `checkout.session.completed` webhook hadn't been
 * delivered. The webhook is still the primary path; this is a safety net the
 * app calls with the `session_id` Stripe puts in the success URL.
 *
 * Every branch is idempotent, so running alongside the webhook is harmless.
 * Body: { session_id: string }
 */
export async function POST(request: Request) {
  const { session_id: sessionId } = (await request.json().catch(() => ({}))) as {
    session_id?: string;
  };
  if (!sessionId) {
    return NextResponse.json({ error: 'session_id required' }, { status: 400 });
  }

  const { user } = await getAuthedContext(request);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const stripe = getStripe();
  const session = await stripe.checkout.sessions.retrieve(sessionId).catch(() => null);
  if (!session) {
    return NextResponse.json({ error: 'Checkout session not found' }, { status: 404 });
  }
  if (session.payment_status !== 'paid' && session.status !== 'complete') {
    return NextResponse.json({ applied: false, reason: 'not_paid' });
  }

  const kind = session.metadata?.kind;
  const admin = createAdminClient();

  // A session only ever unlocks something for the person who started it.
  if (kind === 'package' || kind === 'customer_subscription') {
    if (session.metadata?.user_id !== user.id) {
      return NextResponse.json({ error: 'Not your checkout session' }, { status: 403 });
    }
  }

  if (kind === 'customer_subscription' && session.subscription) {
    const sub = await stripe.subscriptions.retrieve(session.subscription as string);
    const active = ['active', 'trialing'].includes(sub.status);
    const periodEnd = (sub as unknown as { current_period_end?: number }).current_period_end;
    await admin.from('customer_subscriptions').upsert(
      {
        user_id: user.id,
        plan: active ? 'plus' : 'free',
        stripe_subscription_id: sub.id,
        status: sub.status as never,
        current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
        cancel_at_period_end: sub.cancel_at_period_end,
      },
      { onConflict: 'user_id' }
    );
    return NextResponse.json({ applied: true, kind, plan: active ? 'plus' : 'free' });
  }

  if (kind === 'package' && session.metadata?.package_id) {
    const paymentIntent = (session.payment_intent as string) ?? null;
    // The webhook may already have created this row — match on the payment
    // intent so we never double-credit.
    if (paymentIntent) {
      const { data: already } = await admin
        .from('package_purchases')
        .select('id')
        .eq('stripe_payment_intent', paymentIntent)
        .maybeSingle();
      if (already) return NextResponse.json({ applied: false, reason: 'already_credited' });
    }
    const { data: pkg } = await admin
      .from('packages')
      .select('id, provider_id, credits')
      .eq('id', session.metadata.package_id)
      .maybeSingle();
    if (!pkg) return NextResponse.json({ error: 'Package not found' }, { status: 404 });

    const { data: purchase } = await admin
      .from('package_purchases')
      .insert({
        user_id: user.id,
        package_id: pkg.id,
        provider_id: pkg.provider_id,
        credits_total: pkg.credits,
        credits_remaining: pkg.credits,
        stripe_payment_intent: paymentIntent,
      })
      .select('id')
      .single();
    if (purchase && session.metadata?.activity_session_id) {
      await autoBookPackageSession(admin, {
        purchaseId: purchase.id,
        packageId: pkg.id,
        providerId: pkg.provider_id,
        userId: user.id,
        activitySessionId: session.metadata.activity_session_id,
        childId: session.metadata.child_id ?? null,
      });
    }
    return NextResponse.json({ applied: true, kind, credits: pkg.credits });
  }

  if (kind === 'booking' && session.metadata?.booking_id) {
    // RLS is bypassed by the admin client, so scope the write to this parent.
    await admin
      .from('bookings')
      .update({
        payment_status: 'paid',
        status: 'confirmed',
        stripe_payment_intent: (session.payment_intent as string) ?? null,
      })
      .eq('id', session.metadata.booking_id)
      .eq('user_id', user.id);
    return NextResponse.json({ applied: true, kind });
  }

  return NextResponse.json({ applied: false, reason: 'unhandled_kind' });
}
