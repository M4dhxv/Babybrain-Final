import { NextResponse } from 'next/server';
import { getStripe } from '@/lib/stripe';
import { getAuthedContext } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Parent pays for a booking. Creates a Stripe Checkout (destination charge)
 * on the provider's connected account, with the platform commission taken
 * as an application fee. On payment.succeeded the webhook marks the booking
 * paid + confirmed. Body: { booking_id: string }
 */
export async function POST(request: Request) {
  const { booking_id: bookingId } = (await request.json()) as { booking_id?: string };
  if (!bookingId) {
    return NextResponse.json({ error: 'booking_id required' }, { status: 400 });
  }

  const { supabase, user } = await getAuthedContext(request);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  // RLS ensures the parent can only read their own booking.
  const { data: booking } = await supabase
    .from('bookings')
    .select('id, user_id, provider_id, amount, payment_status, status')
    .eq('id', bookingId)
    .maybeSingle();
  if (!booking || booking.user_id !== user.id) {
    return NextResponse.json({ error: 'Booking not found' }, { status: 404 });
  }
  if (booking.payment_status === 'paid') {
    return NextResponse.json({ error: 'Already paid' }, { status: 409 });
  }
  if (!booking.amount || booking.amount <= 0) {
    return NextResponse.json({ error: 'Booking has no payable amount' }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: provider } = await admin
    .from('providers')
    .select('stripe_account_id, payouts_enabled, business_name')
    .eq('id', booking.provider_id!)
    .single();
  if (!provider?.stripe_account_id || !provider.payouts_enabled) {
    return NextResponse.json({ error: 'Provider cannot accept payments yet' }, { status: 409 });
  }

  const { data: sub } = await admin
    .from('subscriptions')
    .select('commission_rate')
    .eq('provider_id', booking.provider_id!)
    .maybeSingle();
  const commission = sub?.commission_rate ?? 0.15;
  const amountCents = Math.round(Number(booking.amount) * 100);
  const feeCents = Math.round(amountCents * commission);

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  const session = await getStripe().checkout.sessions.create({
    mode: 'payment',
    line_items: [
      {
        price_data: {
          currency: 'sgd',
          unit_amount: amountCents,
          product_data: { name: `${provider.business_name} — class booking` },
        },
        quantity: 1,
      },
    ],
    payment_intent_data: {
      application_fee_amount: feeCents,
      transfer_data: { destination: provider.stripe_account_id },
    },
    metadata: { kind: 'booking', booking_id: bookingId },
    success_url: `${appUrl}/dashboard/bookings?status=success`,
    cancel_url: `${appUrl}/dashboard/bookings?status=cancelled`,
  });

  return NextResponse.json({ url: session.url });
}
