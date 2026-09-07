import { NextResponse } from 'next/server';
import { getStripe, ONE_OFF_PAYMENT_METHODS } from '@/lib/stripe';
import { getAuthedContext } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { appOrigin } from '@/lib/cors';
import { sgDateTime } from '@/lib/format';
import { computeSplit, getTerms } from '@/lib/commercials';

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
  const body = (await request.json().catch(() => ({}))) as {
    booking_id?: string;
    group_id?: string | null;
  };

  const { supabase, user } = await getAuthedContext(request);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  // A booking is one or more seat rows sharing a booking_group_id (00084).
  // Accept either the group id or a single booking id (the reconcile path
  // still passes booking_id).
  const seatQuery = supabase
    .from('bookings')
    .select('id, user_id, session_id, payment_status, booking_group_id');
  const { data: seats } = body.group_id
    ? await seatQuery.eq('booking_group_id', body.group_id)
    : body.booking_id
      ? await seatQuery.eq('id', body.booking_id)
      : { data: null };

  if (!seats || seats.length === 0 || seats.some((s) => s.user_id !== user.id)) {
    return NextResponse.json({ error: 'Booking not found' }, { status: 404 });
  }
  if (seats.every((s) => s.payment_status === 'paid')) {
    return NextResponse.json({ error: 'Already paid' }, { status: 409 });
  }
  const booking = seats[0];
  const groupId = booking.booking_group_id ?? null;
  const seatCount = seats.length;

  const admin = createAdminClient();

  // Authoritative price + provider from the booked session's activity.
  //
  // The price is the SESSION's when it has one, falling back to the
  // activity's (migration 00074) — a vendor running the same class at two
  // venues can price them differently, so reading activities.price alone
  // would have charged the wrong amount for one of them. Same resolution the
  // booking trigger uses to decide free vs paid, so the two can't disagree.
  const { data: sess } = await admin
    .from('activity_sessions')
    // starts_at/ends_at and the venue ride along for the confirmation page's
    // summary and its "Add to calendar" button — see success_url below.
    .select('price, starts_at, ends_at, location_id, teacher_name, studio, activities(title, slug, price, provider_id, address), provider_locations(name, address)')
    .eq('id', booking.session_id)
    .maybeSingle();
  const activity = (sess?.activities ?? null) as unknown as
    | { title: string; slug: string; price: number | null; provider_id: string | null; address: string | null }
    | null;
  const venueRow = (sess?.provider_locations ?? null) as unknown as
    | { name: string | null; address: string | null }
    | null;

  const price = Number(sess?.price ?? activity?.price ?? 0);
  if (!price || price <= 0) {
    return NextResponse.json({ error: 'This class is free — no payment needed' }, { status: 400 });
  }
  const unitCents = Math.round(price * 100);
  const amountCents = unitCents * seatCount;

  // Stamp the per-seat amount server-side (parents can't set money columns
  // themselves) across every seat in the party.
  const seatIds = seats.map((s) => s.id);
  await admin.from('bookings').update({ amount: price }).in('id', seatIds);

  const title = activity?.title ?? 'Class booking';
  const origin = appOrigin(request);

  const params = {
    mode: 'payment' as const,
    payment_method_types: ONE_OFF_PAYMENT_METHODS,
    line_items: [
      {
        price_data: {
          currency: 'sgd' as const,
          unit_amount: unitCents,
          product_data: {
            name:
              seatCount > 1
                ? `${title} — class booking (${seatCount} children)`
                : `${title} — class booking`,
          },
        },
        quantity: seatCount,
      },
    ],
    metadata: {
      kind: 'booking',
      booking_id: booking.id,
      ...(groupId ? { booking_group_id: groupId } : {}),
    },
    // session_id lets the app reconcile the payment on return even if the
    // Stripe webhook is delayed or misconfigured (see /api/stripe/reconcile).
    /* QA 04/09: "there should be an add to calendar option on the booking
       confirmation page". There always was one — but it only renders when the
       page is given `start`, and coming back from Stripe it never was, so a
       PAID booking landed on a confirmation with no date, no venue and no
       calendar button. The in-app (free / credit / token) paths already pass
       all four. */
    success_url:
      `${origin}/booked?` +
      new URLSearchParams({
        title,
        slug: activity?.slug ?? '',
        status: 'confirmed',
        paid: '1',
        when: sess?.starts_at ? sgDateTime(sess.starts_at) : '',
        start: sess?.starts_at ?? '',
        end: sess?.ends_at ?? '',
        // Session venue first, then the activity's own address (00074).
        venue:
          [venueRow?.name, venueRow?.address].filter(Boolean).join(', ') ||
          activity?.address ||
          '',
        // Who's taking it and where in the building (QA 24/08).
        staff: [sess?.teacher_name, sess?.studio].filter(Boolean).join(' · '),
      }).toString() +
      // Left unencoded — Stripe substitutes the real id into this placeholder.
      `&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/profile?tab=bookings&booking=cancelled`,
  };

  // Split to the provider's connected account when they're set up; otherwise
  // the charge stays on the platform account so payment still works — and the
  // webhook records what BabyBrain then owes them.
  let connect = {};
  if (activity?.provider_id) {
    const { data: provider } = await admin
      .from('providers')
      .select('stripe_account_id, payouts_enabled')
      .eq('id', activity.provider_id)
      .maybeSingle();
    if (provider?.stripe_account_id && provider.payouts_enabled) {
      const terms = await getTerms(admin, activity.provider_id);
      const split = computeSplit(amountCents, terms);
      connect = {
        payment_intent_data: {
          application_fee_amount: split.applicationFeeCents,
          transfer_data: { destination: provider.stripe_account_id },
        },
      };
    }
  }

  const session = await getStripe().checkout.sessions.create({ ...params, ...connect });
  return NextResponse.json({ url: session.url });
}
