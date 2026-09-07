import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import type Stripe from 'stripe';
import { getStripe } from '@/lib/stripe';
import { computeSplit, getTerms } from '@/lib/commercials';
import { getAuthedContext } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { appOrigin } from '@/lib/cors';
import { sgDateTime } from '@/lib/format';
import { getProviderWixCredentials } from '@/lib/wix/client';
import { checkWixBookingGates, reserveWixSlotForCheckout } from '@/lib/wix/sync';

/**
 * Parent pays for a Wix-linked class. Unlike the free path
 * (/api/wix/bookings) or the credit path (/api/wix/bookings/redeem-package),
 * the actual reservation on Wix is deliberately deferred until payment
 * succeeds — reserveWixSlotForCheckout only confirms the slot is still live
 * and prepares a local session to attach `bookings` rows to; it never calls
 * Wix's create-booking endpoint. That happens in the Stripe webhook's
 * `wix_booking` handler, via the same createWixBookingAndSession the free
 * path uses, once payment is actually confirmed — so a parent who starts
 * checkout and abandons it never leaves a live unpaid hold on the vendor's
 * Wix calendar.
 * Body: { activityId, wixSlotId, childId?, policiesAccepted?, medicalDisclosure?, infoResponse?, count? }
 */
// Every Wix API call is bounded at 20s by wixFetch, and these routes make
// several of them back to back (resolve a slot, create the booking, confirm
// it). On the platform default (~10s) a slow-but-healthy Wix response gets
// the function killed mid-flight and the user sees a bare network error —
// for credentials/bookings that were perfectly fine. Same 60s ceiling the
// other Wix routes already set.
export const maxDuration = 60;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    activityId?: string;
    wixSlotId?: string;
    childId?: string | null;
    policiesAccepted?: string[];
    medicalDisclosure?: string;
    infoResponse?: string;
    count?: number;
    // Names for the extra seats of a multi-child booking (00084).
    guestNames?: string[];
  };
  const { activityId, wixSlotId } = body;
  const count = Math.min(Math.max(Math.trunc(body.count ?? 1), 1), 6);
  if (!activityId || !wixSlotId?.startsWith('wix:')) {
    return NextResponse.json({ error: 'activityId and wixSlotId required' }, { status: 400 });
  }

  const { user } = await getAuthedContext(request);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const admin = createAdminClient();
  const { data: activity } = await admin
    .from('activities')
    .select('id, provider_id, wix_service_id, wix_resource_id, wix_service_type, title, slug, price, address, bookings_paused, booking_cutoff_minutes, info_request_enabled')
    .eq('id', activityId)
    .maybeSingle();
  if (!activity?.wix_service_id || !activity.provider_id) {
    return NextResponse.json({ error: 'Activity is not linked to a Wix service' }, { status: 404 });
  }

  // Authoritative price from the activity, not the client — same rule as
  // the native /api/bookings/checkout.
  const price = Number(activity.price ?? 0);
  if (!price || price <= 0) {
    return NextResponse.json({ error: 'This class is free — no payment needed' }, { status: 400 });
  }

  // Paused / required-information, checked before a Stripe session is ever
  // created. Same reason as the free route: this inserts through the
  // service-role client, which enforce_booking_insert_defaults steps aside
  // for. See checkWixBookingGates.
  const gates = checkWixBookingGates(activity, body.infoResponse);
  if (!gates.ok) return NextResponse.json({ error: gates.error }, { status: gates.status });

  const creds = await getProviderWixCredentials(admin, activity.provider_id);
  if (!creds) {
    return NextResponse.json({ error: 'This business has not connected a Wix account' }, { status: 409 });
  }

  const reserved = await reserveWixSlotForCheckout(
    admin,
    creds,
    { id: activity.id, wix_service_id: activity.wix_service_id, wix_resource_id: activity.wix_resource_id, wix_service_type: activity.wix_service_type },
    wixSlotId,
    count,
    { cutoffMinutes: activity.booking_cutoff_minutes }
  );
  if (!reserved.ok) {
    return NextResponse.json({ error: reserved.error }, { status: reserved.status });
  }

  // One pending row per spot, same as the free path — the capacity/waitlist
  // trigger counts rows, so each child needs to be its own seat rather than
  // the whole party being one row. A party (00084) shares a
  // booking_group_id; seat 1 has the child + medical/info, seats 2..N are
  // "Guest child".
  // Timing + venue of the slot just reserved, for the confirmation page.
  const { data: slot } = await admin
    .from('activity_sessions')
    .select('starts_at, ends_at, provider_locations(name, address)')
    .eq('id', reserved.sessionId)
    .maybeSingle();
  const slotVenue = (slot?.provider_locations ?? null) as unknown as
    | { name: string | null; address: string | null }
    | null;

  const groupId = count > 1 ? randomUUID() : null;
  const rows = Array.from({ length: count }, (_unused, i) => ({
    user_id: user.id,
    child_id: i === 0 ? (body.childId ?? null) : null,
    guest_name: i === 0 ? null : (body.guestNames?.[i - 1]?.trim() || 'Guest child'),
    booking_group_id: groupId,
    session_id: reserved.sessionId,
    status: 'pending' as const,
    payment_status: 'none' as const,
    policies_accepted: body.policiesAccepted ?? [],
    medical_disclosure: i === 0 ? (body.medicalDisclosure || null) : null,
    info_response: i === 0 ? (body.infoResponse?.trim() || null) : null,
  }));
  const { data: bookings, error: bookingError } = await admin.from('bookings').insert(rows).select('id, status');
  if (bookingError || !bookings || bookings.length !== count) {
    console.error('Could not create pending Wix bookings', bookingError);
    return NextResponse.json({ error: 'Could not start payment — contact support' }, { status: 500 });
  }
  // The local capacity trigger waitlists a row itself if this session's
  // already spoken for by other pending reservations (the free-availability
  // check above only sees Wix's own state, not other in-flight local
  // checkouts for the same slot) — never charge for a spot that didn't
  // actually clear that check.
  if (bookings.some((b) => b.status === 'waitlisted')) {
    await admin.from('bookings').delete().in('id', bookings.map((b) => b.id));
    return NextResponse.json(
      { error: count > 1 ? 'Not enough spots left for that many children' : 'That slot just filled up' },
      { status: 409 }
    );
  }
  // Stamped separately, same as the native /api/bookings/checkout — the
  // Insert type only trusts amount on an explicit update, not the initial
  // row creation.
  await admin.from('bookings').update({ amount: price }).in('id', bookings.map((b) => b.id));

  const amountCents = Math.round(price * 100);
  const origin = appOrigin(request);
  const title = activity.title ?? 'Class booking';

  const params = {
    mode: 'payment' as const,
    payment_method_types: ['paynow', 'card', 'grabpay'] as Stripe.Checkout.SessionCreateParams.PaymentMethodType[],
    line_items: [
      {
        price_data: {
          currency: 'sgd' as const,
          unit_amount: amountCents,
          product_data: { name: `${title} — class booking` },
        },
        quantity: count,
      },
    ],
    // wix_slot_id + activity_id let the webhook re-create the real Wix
    // booking on payment; booking_ids is the set of pending rows it flips to
    // paid+confirmed. Everything else needed (child, policies, medical note)
    // is already stored on those rows, not re-passed through Stripe.
    metadata: {
      kind: 'wix_booking',
      booking_ids: JSON.stringify(bookings.map((b) => b.id)),
      activity_id: activity.id,
      wix_slot_id: wixSlotId,
    },
    /* Same as the native checkout: the confirmation page only renders its
       date, venue and "Add to calendar" button when it is given them, and
       coming back from Stripe it never was (QA 04/09). The reserved slot has
       been materialised as a local session by now, so its timing is on hand. */
    success_url:
      `${origin}/booked?` +
      new URLSearchParams({
        title,
        slug: activity.slug ?? '',
        status: 'confirmed',
        paid: '1',
        when: slot?.starts_at ? sgDateTime(slot.starts_at) : '',
        start: slot?.starts_at ?? '',
        end: slot?.ends_at ?? '',
        venue:
          [slotVenue?.name, slotVenue?.address].filter(Boolean).join(', ') ||
          activity.address ||
          '',
      }).toString() +
      // Stripe substitutes the real id into this placeholder — leave it raw.
      `&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/profile?tab=bookings&booking=cancelled`,
  };

  // Split to the provider's connected account when they're set up; otherwise
  // the charge stays on the platform account so payment still works — same
  // as the native /api/bookings/checkout.
  let connect = {};
  const { data: provider } = await admin
    .from('providers')
    .select('stripe_account_id, payouts_enabled')
    .eq('id', activity.provider_id)
    .maybeSingle();
  if (provider?.stripe_account_id && provider.payouts_enabled) {
    // The vendor's negotiated terms in full — commission rate, any flat
    // per-sale fee, and the Stripe-fee recovery when they've agreed to
    // absorb it — exactly as the native /api/bookings/checkout computes it.
    // Reading commission_rate on its own quietly dropped the other two, so
    // the same class sold through Wix and through BabyBrain's own scheduler
    // paid two different commissions.
    const terms = await getTerms(admin, activity.provider_id);
    const split = computeSplit(amountCents * count, terms);
    connect = {
      payment_intent_data: {
        application_fee_amount: split.applicationFeeCents,
        transfer_data: { destination: provider.stripe_account_id },
      },
    };
  }

  const session = await getStripe().checkout.sessions.create({ ...params, ...connect });
  return NextResponse.json({ url: session.url });
}
