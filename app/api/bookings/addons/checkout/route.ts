import { NextResponse } from 'next/server';
import { getStripe, ONE_OFF_PAYMENT_METHODS } from '@/lib/stripe';
import { getAuthedContext } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { appOrigin } from '@/lib/cors';
import { computeSplit, getTerms } from '@/lib/commercials';
import { normalisePicks, prepareAddonRows, releaseAddonRows, settleAddonRows } from '@/lib/booking-addons';
import { creditBalance, newHoldId, reserveCredit } from '@/lib/make-up-credit';

/**
 * Add people to a booking the parent already holds, and pay only for the add-ons (migration 00273).
 *
 * Used both from "My bookings" ("Add a person") and straight after a booking made without a card
 * checkout (a free class, a pack credit, a make-up token) when the parent also ticked add-ons.
 *
 * Body: { addons: [{ addon_id, quantity, names? }], booking_id? | group_id? | session_id? }
 * The booking is found by whichever id is given; session_id picks the parent's latest live booking
 * on that session. Prices are read from the vendor's catalogue server-side, never from the client.
 * Add-ons take no class capacity, so a full class never blocks them.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    booking_id?: string;
    group_id?: string;
    session_id?: string;
    addons?: unknown;
    /** Pay with the parent's make-up token balance with this vendor first (00276). */
    use_credit?: boolean;
  };

  const { supabase, user } = await getAuthedContext(request);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const picks = normalisePicks(body.addons);
  if (picks.length === 0) return NextResponse.json({ error: 'Pick at least one add-on.' }, { status: 400 });

  // The caller's own bookings only (RLS), oldest first so the lead seat is seat 1 of a party.
  let seatQuery = supabase
    .from('bookings')
    .select('id, user_id, session_id, status, created_at, booking_group_id')
    .eq('user_id', user.id)
    .in('status', ['pending', 'confirmed'])
    .order('created_at', { ascending: true });
  if (body.booking_id) seatQuery = seatQuery.eq('id', body.booking_id);
  else if (body.group_id) seatQuery = seatQuery.eq('booking_group_id', body.group_id);
  else if (body.session_id) seatQuery = seatQuery.eq('session_id', body.session_id);
  else return NextResponse.json({ error: 'Booking not found' }, { status: 404 });
  const { data: seats } = await seatQuery;
  // A session_id lookup means "my latest booking on that session", not its first ever.
  const lead = body.session_id && !body.booking_id && !body.group_id ? seats?.[seats.length - 1] : seats?.[0];
  if (!lead || !lead.session_id) return NextResponse.json({ error: 'Booking not found' }, { status: 404 });

  const admin = createAdminClient();
  const { data: sess } = await admin
    .from('activity_sessions')
    .select('starts_at, activities(id, title, slug, provider_id)')
    .eq('id', lead.session_id)
    .maybeSingle();
  const activity = (sess?.activities ?? null) as unknown as
    | { id: string; title: string; slug: string; provider_id: string | null }
    | null;
  if (!sess || !activity?.provider_id) return NextResponse.json({ error: 'Booking not found' }, { status: 404 });
  if (new Date(sess.starts_at).getTime() < Date.now()) {
    return NextResponse.json({ error: 'This session has already started — people can no longer be added.' }, { status: 409 });
  }

  // The whole party's seats, so the vendor's per-booking cap counts add-ons held on any of them.
  let partyBookingIds = [lead.id];
  if (lead.booking_group_id) {
    const { data: party } = await admin.from('bookings').select('id').eq('booking_group_id', lead.booking_group_id);
    if (party?.length) partyBookingIds = party.map((r) => r.id);
  }

  const prepared = await prepareAddonRows(admin, {
    bookingId: lead.id,
    partyBookingIds,
    userId: user.id,
    activityId: activity.id,
    activityTitle: activity.title,
    providerId: activity.provider_id,
    picks,
  });
  if (!prepared.ok) return NextResponse.json({ error: prepared.error }, { status: prepared.status });

  // Nothing to charge (every pick is a free add-on): record it as held straight away.
  if (prepared.totalCents <= 0) {
    await settleAddonRows(admin, prepared.rowIds, null, user.id);
    return NextResponse.json({ done: true });
  }

  // Make-up credit (00276): the parent's balance with this vendor pays first, the card pays the rest.
  let creditCents = 0;
  if (body.use_credit) {
    const balance = await creditBalance(admin, user.id, activity.provider_id);
    // Stripe will not take a charge under 50c, so keep that much on the card rather than leave less.
    let want = Math.min(prepared.totalCents, balance);
    if (prepared.totalCents - want > 0 && prepared.totalCents - want < 50) want = Math.max(prepared.totalCents - 50, 0);
    let need = want;
    const items = prepared.rowIds.map((rowId, i) => {
      const cents = Math.min(prepared.rowCents[i] ?? 0, need);
      need -= cents;
      return { addonRowId: rowId, cents };
    });
    const reserved = await reserveCredit(admin, {
      userId: user.id,
      providerId: activity.provider_id,
      holdId: newHoldId(),
      refKind: 'addon',
      items,
    });
    creditCents = reserved.total;
  }
  const cardCents = prepared.totalCents - creditCents;
  if (creditCents > 0 && cardCents <= 0) {
    // Credit covers it all: no card. Marking the rows paid also settles their credit.
    await settleAddonRows(admin, prepared.rowIds, null, user.id);
    return NextResponse.json({ done: true, credit_only: true });
  }

  const origin = appOrigin(request);
  let connect = {};
  const { data: provider } = await admin
    .from('providers')
    .select('stripe_account_id, payouts_enabled')
    .eq('id', activity.provider_id)
    .maybeSingle();
  if (provider?.stripe_account_id && provider.payouts_enabled) {
    const terms = await getTerms(admin, activity.provider_id);
    const split = computeSplit(cardCents, terms);
    connect = {
      payment_intent_data: {
        application_fee_amount: split.applicationFeeCents,
        transfer_data: { destination: provider.stripe_account_id },
      },
    };
  }

  try {
    const session = await getStripe().checkout.sessions.create({
      mode: 'payment',
      expires_at: Math.floor(Date.now() / 1000) + 40 * 60,
      payment_method_types: ONE_OFF_PAYMENT_METHODS,
      line_items:
        creditCents > 0
          ? [
              {
                price_data: {
                  currency: 'sgd' as const,
                  unit_amount: cardCents,
                  product_data: {
                    name: `${activity.title} — extra people (after $${(creditCents / 100).toFixed(2)} make-up token)`,
                  },
                },
                quantity: 1,
              },
            ]
          : prepared.lineItems,
      metadata: {
        kind: 'booking_addon',
        booking_id: lead.id,
        user_id: user.id,
        addon_row_ids: prepared.rowIds.join(','),
      },
      // session_id lets the Profile page reconcile on return even if the webhook is late.
      success_url: `${origin}/profile?tab=bookings&addon=paid&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/profile?tab=bookings`,
      ...connect,
    });
    return NextResponse.json({ url: session.url });
  } catch (e) {
    // No checkout was created, so don't leave unpaid rows lying about.
    await releaseAddonRows(admin, prepared.rowIds);
    console.error('[addons/checkout] Stripe failed:', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Could not start payment — please try again.' }, { status: 502 });
  }
}
