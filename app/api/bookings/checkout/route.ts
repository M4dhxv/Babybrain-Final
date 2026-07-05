import { NextResponse } from 'next/server';
import { getStripe } from '@/lib/stripe';
import { getAuthedContext } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { appOrigin } from '@/lib/cors';

/**
 * Parent pays for a booking. The price is resolved server-side from the
 * activity (never trusted from the client), stamped onto the booking, and
 * charged via Stripe Checkout. When the provider has completed Stripe Connect
 * the charge is split to their account with the platform commission as an
 * application fee; otherwise it's taken on the platform account so payment
 * still works. On payment the webhook (kind='booking') marks it paid+confirmed.
 * Body: { booking_id: string }
 */
export async function POST(request: Request) {
  const { booking_id: bookingId } = (await request.json().catch(() => ({}))) as { booking_id?: string };
  if (!bookingId) {
    return NextResponse.json({ error: 'booking_id required' }, { status: 400 });
  }

  const { supabase, user } = await getAuthedContext(request);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  // RLS ensures the parent can only read their own booking.
  const { data: booking } = await supabase
    .from('bookings')
    .select('id, user_id, session_id, payment_status')
    .eq('id', bookingId)
    .maybeSingle();
  if (!booking || booking.user_id !== user.id) {
    return NextResponse.json({ error: 'Booking not found' }, { status: 404 });
  }
  if (booking.payment_status === 'paid') {
    return NextResponse.json({ error: 'Already paid' }, { status: 409 });
  }

  const admin = createAdminClient();

  // Authoritative price + provider from the booked session's activity.
  const { data: sess } = await admin
    .from('activity_sessions')
    .select('activities(title, slug, price, provider_id)')
    .eq('id', booking.session_id)
    .maybeSingle();
  const activity = (sess?.activities ?? null) as unknown as
    | { title: string; slug: string; price: number | null; provider_id: string | null }
    | null;

  const price = Number(activity?.price ?? 0);
  if (!price || price <= 0) {
    return NextResponse.json({ error: 'This class is free — no payment needed' }, { status: 400 });
  }
  const amountCents = Math.round(price * 100);

  // Stamp the amount server-side (parents can't set money columns themselves).
  await admin.from('bookings').update({ amount: price }).eq('id', bookingId);

  const title = activity?.title ?? 'Class booking';
  const origin = appOrigin(request);

  const params = {
    mode: 'payment' as const,
    line_items: [
      {
        price_data: {
          currency: 'sgd' as const,
          unit_amount: amountCents,
          product_data: { name: `${title} — class booking` },
        },
        quantity: 1,
      },
    ],
    metadata: { kind: 'booking', booking_id: bookingId },
    success_url: `${origin}/booked?title=${encodeURIComponent(title)}&status=confirmed&paid=1`,
    cancel_url: `${origin}/profile?tab=bookings&booking=cancelled`,
  };

  // Split to the provider's connected account when they're set up; otherwise
  // the charge stays on the platform account so payment still works.
  let connect = {};
  if (activity?.provider_id) {
    const { data: provider } = await admin
      .from('providers')
      .select('stripe_account_id, payouts_enabled')
      .eq('id', activity.provider_id)
      .maybeSingle();
    if (provider?.stripe_account_id && provider.payouts_enabled) {
      const { data: sub } = await admin
        .from('subscriptions')
        .select('commission_rate')
        .eq('provider_id', activity.provider_id)
        .maybeSingle();
      const commission = sub?.commission_rate ?? 0.15;
      connect = {
        payment_intent_data: {
          application_fee_amount: Math.round(amountCents * commission),
          transfer_data: { destination: provider.stripe_account_id },
        },
      };
    }
  }

  const session = await getStripe().checkout.sessions.create({ ...params, ...connect });
  return NextResponse.json({ url: session.url });
}
