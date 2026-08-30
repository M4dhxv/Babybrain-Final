import { NextResponse } from 'next/server';
import { getStripe } from '@/lib/stripe';
import { getAuthedContext } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { autoBookPackageSession } from '@/lib/stripe-package-auto-book';
import { recordSale } from '@/lib/commercials';
import { finalizeWixBookingCheckout } from '@/lib/wix/finalize-checkout';
import { finalizeWixEventTicketCheckout } from '@/lib/wix/finalize-event-checkout';

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
      .select('id, provider_id, credits, price_cents')
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
    if (purchase) {
      await recordSale(admin, {
        providerId: pkg.provider_id,
        source: 'package',
        packagePurchaseId: purchase.id,
        grossCents: pkg.price_cents,
        paymentIntentId: paymentIntent,
      });
    }
    return NextResponse.json({ applied: true, kind, credits: pkg.credits });
  }

  if (kind === 'wix_booking' && session.metadata?.booking_ids) {
    // A session only ever unlocks something for the person who started it —
    // same rule as package/customer_subscription above.
    let bookingIds: string[] = [];
    try {
      bookingIds = JSON.parse(session.metadata.booking_ids);
    } catch {
      return NextResponse.json({ error: 'Malformed checkout session' }, { status: 400 });
    }
    const { data: owned } = await admin.from('bookings').select('id').in('id', bookingIds).eq('user_id', user.id);
    if (!owned || owned.length !== bookingIds.length) {
      return NextResponse.json({ error: 'Not your checkout session' }, { status: 403 });
    }
    await finalizeWixBookingCheckout(admin, session);
    return NextResponse.json({ applied: true, kind });
  }

  if (kind === 'wix_event_ticket' && session.metadata?.order_id) {
    // Same ownership rule as wix_booking above.
    const { data: owned } = await admin
      .from('event_ticket_orders')
      .select('id')
      .eq('id', session.metadata.order_id)
      .eq('user_id', user.id)
      .maybeSingle();
    if (!owned) {
      return NextResponse.json({ error: 'Not your checkout session' }, { status: 403 });
    }
    await finalizeWixEventTicketCheckout(admin, session);
    return NextResponse.json({ applied: true, kind });
  }

  if (kind === 'booking' && session.metadata?.booking_id) {
    const bookingId = session.metadata.booking_id;
    const paymentIntent = (session.payment_intent as string) ?? null;
    // RLS is bypassed by the admin client, so scope the write to this parent.
    await admin
      .from('bookings')
      .update({
        payment_status: 'paid',
        status: 'confirmed',
        stripe_payment_intent: paymentIntent,
      })
      .eq('id', bookingId)
      .eq('user_id', user.id);

    // Same ledger entry the webhook would have written. recordSale is
    // idempotent on the payment intent, so whichever path runs first wins.
    const { data: booked } = await admin
      .from('bookings')
      .select('amount, provider_id')
      .eq('id', bookingId)
      .eq('user_id', user.id)
      .maybeSingle();
    if (booked?.provider_id) {
      await recordSale(admin, {
        providerId: booked.provider_id,
        source: 'booking',
        bookingId,
        grossCents: Math.round(Number(booked.amount ?? 0) * 100),
        paymentIntentId: paymentIntent,
      });
    }
    return NextResponse.json({ applied: true, kind });
  }

  return NextResponse.json({ applied: false, reason: 'unhandled_kind' });
}
