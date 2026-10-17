import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getStripe, ONE_OFF_PAYMENT_METHODS } from '@/lib/stripe';
import { getAuthedContext } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { appOrigin } from '@/lib/cors';
import { sgDateTime } from '@/lib/format';
import { computeSplit, getTerms } from '@/lib/commercials';
import { confirmPaidBookingSeats } from '@/lib/confirm-paid-booking-seats';

/**
 * Parent pays for a term enrolment, a trial class or a single class of a term
 * (migration 00243).
 *
 * The seats already exist: enrol_in_term() / book_term_class() created them as
 * ordinary `pending` bookings sharing a booking_group_id. This route prices them
 * from the term — never from the client — stamps the amount on each seat, and
 * sends the parent through the same Stripe Checkout the single-class flow uses
 * (metadata kind 'booking'), so the webhook, reconcile, earnings ledger and the
 * pending-seat clean-up all work unchanged.
 *
 *   term   the enrolment's quoted price (after any mid-term reduction), split
 *          across its seats
 *   trial  the term's trial price per seat
 *   single the term's single-class price per seat
 *
 * Body: { group_id: string }
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { group_id?: string };
  const { user } = await getAuthedContext(request);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  if (!body.group_id) return NextResponse.json({ error: 'group_id is required' }, { status: 400 });

  // The term columns are newer than the generated Database types, so these
  // reads go through an untyped client.
  const admin = createAdminClient();
  const db = admin as unknown as SupabaseClient;

  const { data: seats } = await db
    .from('bookings')
    .select('id, user_id, session_id, status, payment_status, term_booking_kind, term_enrolment_id')
    .eq('booking_group_id', body.group_id);

  if (!seats || seats.length === 0 || seats.some((s) => s.user_id !== user.id)) {
    return NextResponse.json({ error: 'Booking not found' }, { status: 404 });
  }
  if (seats.every((s) => s.payment_status === 'paid')) {
    return NextResponse.json({ error: 'Already paid' }, { status: 409 });
  }
  if (seats.every((s) => s.status === 'cancelled')) {
    return NextResponse.json({ error: 'This booking has been cancelled' }, { status: 409 });
  }

  const kind = seats[0].term_booking_kind as 'term' | 'single' | 'trial' | 'package' | null;
  if (!kind || seats.some((s) => s.term_booking_kind !== kind)) {
    return NextResponse.json({ error: 'This is not a term booking' }, { status: 400 });
  }
  if (kind === 'package') {
    return NextResponse.json({ error: 'A package booking is paid with credits' }, { status: 400 });
  }

  // Only the seats that are held and unpaid are charged. A waitlisted seat is
  // claimed later through the normal waitlist flow.
  const chargeSeats = seats.filter((s) => s.status === 'pending' && s.payment_status !== 'paid');
  if (chargeSeats.length === 0) {
    return NextResponse.json({ error: 'Nothing left to pay for on this booking' }, { status: 409 });
  }
  const seatCount = chargeSeats.length;
  const seatIds = chargeSeats.map((s) => s.id as string);

  // The first class names the booking; the term it belongs to sets the price.
  const { data: sessions } = await db
    .from('activity_sessions')
    .select(
      'id, starts_at, ends_at, term_slot_id, activities(title, slug, provider_id, address), provider_locations(name, address), ' +
        'term_slots(terms(id, name, single_price_cents, trial_price_cents))'
    )
    .in('id', chargeSeats.map((s) => s.session_id as string))
    .order('starts_at', { ascending: true });
  type TermRef = { id: string; name: string; single_price_cents: number; trial_price_cents: number };
  type SessionRow = {
    starts_at: string;
    ends_at: string;
    activities: { title: string; slug: string; provider_id: string | null; address: string | null } | null;
    provider_locations: { name: string | null; address: string | null } | null;
    term_slots: { terms: TermRef | null } | null;
  };
  const rows = (sessions ?? []) as unknown as SessionRow[];
  const first = rows[0];
  const term = first?.term_slots?.terms ?? null;
  const activity = first?.activities ?? null;
  if (!first || !term) {
    return NextResponse.json({ error: 'This session is not part of a term' }, { status: 400 });
  }

  let totalCents: number;
  if (kind === 'term') {
    // One group can hold several children's enrolments (siblings paid in one
    // checkout, 00244); each is charged its own quoted price.
    const heldBy = new Map<string, number>();
    for (const s of chargeSeats) {
      const id = s.term_enrolment_id as string | null;
      if (id) heldBy.set(id, (heldBy.get(id) ?? 0) + 1);
    }
    const { data: enrols } = await db
      .from('term_enrolments')
      .select('id, price_cents, sessions, user_id')
      .in('id', [...heldBy.keys()]);
    if (!enrols || enrols.length !== heldBy.size || enrols.some((e) => e.user_id !== user.id)) {
      return NextResponse.json({ error: 'Enrolment not found' }, { status: 404 });
    }
    // If the vendor skipped a class after enrolment, those seats were
    // cancelled; charge only for the classes still held.
    totalCents = enrols.reduce(
      (sum, e) => sum + Math.round((Number(e.price_cents) * (heldBy.get(e.id as string) ?? 0)) / Math.max(1, Number(e.sessions))),
      0
    );
  } else if (kind === 'trial') {
    totalCents = Number(term.trial_price_cents) * seatCount;
  } else {
    totalCents = Number(term.single_price_cents) * seatCount;
  }

  // Stamp what each seat cost, server-side (a parent can't set money columns).
  // A term price rarely divides evenly, so the odd cents go to the first seats
  // and the seats always sum to exactly what is charged.
  const base = Math.floor(totalCents / seatCount);
  const extra = totalCents - base * seatCount;
  const now = new Date().toISOString();
  await Promise.all(
    seatIds.map((id, i) =>
      db
        .from('bookings')
        .update({ amount: (base + (i < extra ? 1 : 0)) / 100, checkout_started_at: now })
        .eq('id', id)
    )
  );

  const title = `${activity?.title ?? 'Term'} · ${term.name}`;
  const origin = appOrigin(request);
  const venue =
    [first.provider_locations?.name, first.provider_locations?.address].filter(Boolean).join(', ') ||
    activity?.address ||
    '';
  const successUrl =
    `${origin}/booked?` +
    new URLSearchParams({
      title,
      slug: activity?.slug ?? '',
      status: 'confirmed',
      paid: totalCents > 0 ? '1' : '0',
      when: sgDateTime(first.starts_at),
      start: first.starts_at,
      end: first.ends_at,
      venue,
    }).toString();

  // Free (a term reduced to nothing, or a free trial): nothing to charge, so
  // settle the seats directly.
  if (totalCents <= 0) {
    const { failed } = await confirmPaidBookingSeats(admin as never, {
      seatIds,
      groupId: body.group_id,
      paymentIntent: null,
      scopeUserId: user.id,
    });
    if (failed) return NextResponse.json({ error: 'Could not confirm the booking. Please try again.' }, { status: 503 });
    return NextResponse.json({ url: successUrl, free: true });
  }

  const unitLabel =
    kind === 'term'
      ? (() => {
          const kids = new Set(chargeSeats.map((s) => s.term_enrolment_id)).size;
          return kids > 1
            ? `${title} · whole term for ${kids} children`
            : `${title} · whole term (${seatCount} ${seatCount === 1 ? 'session' : 'sessions'})`;
        })()
      : kind === 'trial'
        ? `${title} · trial session`
        : `${title} · single session`;

  const params = {
    mode: 'payment' as const,
    expires_at: Math.floor(Date.now() / 1000) + 40 * 60,
    payment_method_types: ONE_OFF_PAYMENT_METHODS,
    line_items: [
      {
        price_data: {
          currency: 'sgd' as const,
          unit_amount: totalCents,
          product_data: { name: unitLabel },
        },
        quantity: 1,
      },
    ],
    metadata: {
      kind: 'booking',
      booking_id: seatIds[0],
      booking_group_id: body.group_id,
      // A term has too many seats to list: Stripe caps a metadata value at 500
      // characters. Settlement falls back to the booking group, which holds
      // exactly this enrolment's seats.
      term_booking: kind,
    },
    success_url: `${successUrl}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/profile?tab=bookings&booking=cancelled`,
  };

  // Same split as a single-class booking: to the provider's connected account
  // with the platform commission when they have one, otherwise on the platform.
  let connect = {};
  if (activity?.provider_id) {
    const { data: provider } = await admin
      .from('providers')
      .select('stripe_account_id, payouts_enabled')
      .eq('id', activity.provider_id)
      .maybeSingle();
    if (provider?.stripe_account_id && provider.payouts_enabled) {
      const terms = await getTerms(admin, activity.provider_id);
      const split = computeSplit(totalCents, terms);
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
