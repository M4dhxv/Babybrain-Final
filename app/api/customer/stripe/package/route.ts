import { NextResponse } from 'next/server';
import { getStripe, ONE_OFF_PAYMENT_METHODS } from '@/lib/stripe';
import { getAuthedContext } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { appOrigin } from '@/lib/cors';
import { computeSplit, getTerms } from '@/lib/commercials';
import { companionSettingsFor, packCompanionMetadata, validateCompanions } from '@/lib/companions';
import { creditBalance, newHoldId, releaseHold, reserveCredit, settleHold } from '@/lib/make-up-credit';
import { purchasePackageAndBook } from '@/lib/stripe-package-purchase';
import { notifyPackagePurchased } from '@/lib/notify-package-purchased';
import type Stripe from 'stripe';

/**
 * Parent buys a class package (multi-session pack). One-off Stripe Checkout;
 * the webhook (kind='package') creates the package_purchases row with
 * credits, and — when a session was chosen — atomically books it too (see
 * purchase_package_and_book, migration 00162).
 * Body: { package_id: string, activity_session_id?: string, child_id?: string,
 *   quantity?: number, guest_names?: string[], policies_accepted?: string[],
 *   medical_disclosure?: string, info_response?: string }
 *
 * activity_session_id/child_id/quantity/etc. are only present when checkout
 * was started from a specific class's booking page — QA: buying the pack
 * there should also book that class (for the whole party, not just one
 * seat), not just grant credits. The booking-page UI now requires a chosen
 * slot before it will call this at all; quantity is still capped and
 * cross-checked against the pack's own credit total here as a second line of
 * defense against a stale or bypassed client.
 */
export async function POST(request: Request) {
  const {
    package_id: packageId,
    activity_session_id: activitySessionId,
    child_id: childId,
    quantity: rawQuantity,
    guest_names: guestNames,
    policies_accepted: policiesAccepted,
    medical_disclosure: medicalDisclosure,
    info_response: infoResponse,
    companions: rawCompanions,
    use_credit: useCredit,
  } = (await request.json().catch(() => ({}))) as {
    package_id?: string;
    activity_session_id?: string;
    child_id?: string;
    quantity?: number;
    guest_names?: string[];
    policies_accepted?: string[];
    medical_disclosure?: string;
    info_response?: string;
    /** Companion mode: [{ seat, name, age }] for the class being booked with the pack (00273). */
    companions?: unknown;
    /** Pay with the parent's make-up token balance with this vendor first; the card pays the rest (00276). */
    use_credit?: boolean;
  };
  if (!packageId) {
    return NextResponse.json({ error: 'package_id required' }, { status: 400 });
  }
  // Only meaningful alongside a session to book; capped well above any real
  // party size so a bad value can't blow up the booking loop or Stripe
  // metadata size.
  const quantity = Math.min(Math.max(1, Math.trunc(Number(rawQuantity) || 1)), 20);

  const { user } = await getAuthedContext(request);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const admin = createAdminClient();
  const { data: pkg } = await admin
    .from('packages')
    .select('id, name, credits, price_cents, active, provider_id, starts_at, expiry_date, activity_ids')
    .eq('id', packageId)
    .maybeSingle();
  if (!pkg || !pkg.active) {
    return NextResponse.json({ error: 'Package not available' }, { status: 404 });
  }
  // Vendor-scheduled pack: not yet on sale, or past its fixed expiry date
  // (00134/00132) — the browse UI already hides these, this is the
  // checkout-can't-be-bypassed backstop.
  const now = new Date();
  if (pkg.starts_at && new Date(pkg.starts_at) > now) {
    return NextResponse.json({ error: 'Package not available yet' }, { status: 404 });
  }
  if (pkg.expiry_date && new Date(`${pkg.expiry_date}T23:59:59+08:00`) <= now) {
    return NextResponse.json({ error: 'Package not available' }, { status: 404 });
  }
  // A pack that can't cover the whole party shouldn't be paid for at all —
  // the booking-page UI already blocks this before calling here, this is the
  // checkout-can't-be-bypassed backstop (same idea as the on-sale checks
  // above).
  if (activitySessionId && quantity > pkg.credits) {
    return NextResponse.json(
      { error: `This pack only has ${pkg.credits} credit${pkg.credits === 1 ? '' : 's'} — not enough for ${quantity} children.` },
      { status: 400 }
    );
  }

  // Companion mode (00273): a pack bought for a companion class must be that class's own pack, and the
  // companions entered here are checked now (so nothing invalid reaches Stripe) and carried in the
  // checkout metadata to be attached to the seats the webhook books.
  let companionMeta: Record<string, string> = {};
  if (activitySessionId) {
    const { data: sessRow } = await admin.from('activity_sessions').select('activity_id').eq('id', activitySessionId).maybeSingle();
    const settings = sessRow?.activity_id ? await companionSettingsFor(admin, sessRow.activity_id) : null;
    if (settings?.companion_enabled) {
      const ids = (pkg as { activity_ids?: string[] | null }).activity_ids ?? [];
      if (ids.length !== 1 || ids[0] !== sessRow?.activity_id) {
        return NextResponse.json({ error: "This class includes a companion, so only a pack made for this class alone can be used with it." }, { status: 400 });
      }
    }
    if (settings) {
      const checked = validateCompanions(settings, quantity, rawCompanions);
      if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });
      companionMeta = packCompanionMetadata(checked.list);
    }
  }

  // The class booked alongside the pack must be bookable right now. The seat is
  // inserted later by the webhook as the service role, and
  // enforce_booking_insert_defaults() skips every parent-facing check for the
  // service role — so without this, a parent could pay for a class inside the
  // vendor's booking cutoff (28 Sep: a 24h-cutoff class booked 17h out) that
  // the normal booking flow refuses. Same rules and same wording as that
  // trigger, so both flows show the parent the identical message.
  if (activitySessionId) {
    const { data: sess } = await admin
      .from('activity_sessions')
      .select('starts_at, bookings_paused, booking_cutoff_minutes, activities(provider_id, bookings_paused, booking_cutoff_minutes, providers(status))')
      .eq('id', activitySessionId)
      .maybeSingle();
    const act = sess?.activities as unknown as {
      provider_id: string | null;
      bookings_paused: boolean | null;
      booking_cutoff_minutes: number | null;
      providers: { status: string | null } | null;
    } | null;
    if (!sess || !act || act.provider_id !== pkg.provider_id) {
      return NextResponse.json({ error: 'This class can’t be booked with this package.' }, { status: 400 });
    }
    if ((act.providers?.status ?? 'active') !== 'active') {
      return NextResponse.json({ error: 'This provider is not currently taking bookings.' }, { status: 400 });
    }
    if (act.bookings_paused) {
      return NextResponse.json({ error: 'Bookings for this class are currently paused.' }, { status: 400 });
    }
    if (sess.bookings_paused) {
      return NextResponse.json(
        { error: 'Bookings for this session are currently paused — other dates may still be available.' },
        { status: 400 }
      );
    }
    const cutoff = sess.booking_cutoff_minutes ?? act.booking_cutoff_minutes ?? 15;
    if (sess.starts_at && new Date(sess.starts_at).getTime() - cutoff * 60_000 <= now.getTime()) {
      return NextResponse.json(
        {
          error: cutoff === 0
            ? 'This class has already started.'
            : 'Bookings for this class are closed.',
        },
        { status: 400 }
      );
    }
  }

  // Packs are for classes only. Buying one to book a Wix Event, COURSE or
  // APPOINTMENT occurrence would take payment for a pack that can never be
  // redeemed there — the booking page hides the option, this is the backstop.
  if (activitySessionId) {
    const { data: target } = await admin
      .from('activity_sessions')
      .select('activities(wix_service_type)')
      .eq('id', activitySessionId)
      .maybeSingle();
    const targetType = (target?.activities as { wix_service_type: string | null } | null)?.wix_service_type ?? '';
    if (['EVENT', 'COURSE', 'APPOINTMENT'].includes(targetType)) {
      return NextResponse.json({ error: 'Packages can only be used on classes.' }, { status: 400 });
    }
  }

  const origin = appOrigin(request);

  // What rides along to the purchase: the same keys whether a card pays or credit does.
  const metadata: Record<string, string> = {
    kind: 'package',
    user_id: user.id,
    package_id: pkg.id,
    // The rest only matter alongside a session to book — no point
    // shipping booking paperwork for a pack bought with no class attached.
    ...(activitySessionId
      ? {
          activity_session_id: activitySessionId,
          quantity: String(quantity),
          ...companionMeta,
          ...(childId ? { child_id: childId } : {}),
          ...(guestNames && guestNames.length
            ? { guest_names: JSON.stringify(guestNames.slice(0, 19).map((n) => String(n).slice(0, 80))) }
            : {}),
          ...(policiesAccepted && policiesAccepted.length
            ? { policies_accepted: JSON.stringify(policiesAccepted.slice(0, 50)) }
            : {}),
          ...(medicalDisclosure?.trim() ? { medical_disclosure: medicalDisclosure.trim().slice(0, 450) } : {}),
          // A metadata value holds at most 500 characters, and with a vendor's
          // second question (00252) both answers travel here under their
          // questions, so it is split over two keys and rejoined on fulfilment
          // (lib/stripe-package-purchase.ts) instead of being cut at 450.
          ...(infoResponse?.trim()
            ? {
                info_response: infoResponse.trim().slice(0, 500),
                ...(infoResponse.trim().length > 500 ? { info_response_2: infoResponse.trim().slice(500, 1000) } : {}),
              }
            : {}),
        }
      : {}),
  };

  // Make-up credit (00276): the balance with this vendor pays first, the card pays the rest.
  let creditCents = 0;
  let holdId: string | null = null;
  if (useCredit) {
    const balance = await creditBalance(admin, user.id, pkg.provider_id);
    // Stripe will not take a charge under 50c, so keep that much on the card rather than leave less.
    let want = Math.min(pkg.price_cents, balance);
    if (pkg.price_cents - want > 0 && pkg.price_cents - want < 50) want = Math.max(pkg.price_cents - 50, 0);
    if (want > 0) {
      holdId = newHoldId();
      const reserved = await reserveCredit(admin, {
        userId: user.id,
        providerId: pkg.provider_id,
        holdId,
        refKind: 'package',
        refId: pkg.id,
        items: [{ cents: want }],
      });
      creditCents = reserved.total;
    }
  }
  const cardCents = pkg.price_cents - creditCents;

  // Credit covers the whole pack: no card. Grant it the way the webhook would, against a payment id that
  // is the hold (purchase_package_and_book dedupes on it, so a double click cannot grant it twice).
  if (creditCents > 0 && cardCents <= 0 && holdId) {
    const fake = { id: `credit_${holdId}`, metadata, payment_intent: `credit:${holdId}` } as unknown as Stripe.Checkout.Session;
    const result = await purchasePackageAndBook(admin, fake);
    if (!result || !result.package) {
      await releaseHold(admin, holdId);
      return NextResponse.json({ error: 'Could not complete the purchase — your balance has not been used. Please try again.' }, { status: 500 });
    }
    await settleHold(admin, holdId);
    if (!result.alreadyCredited) {
      await notifyPackagePurchased(admin, {
        userId: user.id,
        packageId: result.package.id,
        providerId: result.package.provider_id,
        purchaseId: result.purchaseId,
        credits: result.package.credits,
      });
    }
    return NextResponse.json({ url: `${origin}/profile?tab=packages&purchase=success`, credit_only: true });
  }

  // Class packs are vendor revenue, but this checkout never split them: the
  // whole purchase landed on the platform account with nothing transferred to
  // the provider. Split it the same way a booking is split, unless the
  // vendor's terms exempt packages.
  let connect = {};
  const { data: provider } = await admin
    .from('providers')
    .select('stripe_account_id, payouts_enabled')
    .eq('id', pkg.provider_id)
    .maybeSingle();
  if (provider?.stripe_account_id && provider.payouts_enabled) {
    const terms = await getTerms(admin, pkg.provider_id);
    // BabyBrain's cut is taken on the card part only: the vendor was paid for the credit part already.
    const split = terms.commissionOnPackages
      ? computeSplit(cardCents, terms)
      : computeSplit(cardCents, { ...terms, commissionRate: 0, commissionFlatCents: 0 });
    connect = {
      payment_intent_data: {
        application_fee_amount: split.applicationFeeCents,
        transfer_data: { destination: provider.stripe_account_id },
      },
    };
  }

  const creditNote = creditCents > 0 ? ` (after $${(creditCents / 100).toFixed(2)} make-up token)` : '';
  let session: Stripe.Checkout.Session;
  try {
  session = await getStripe().checkout.sessions.create({
    mode: 'payment',
    ...connect,
    payment_method_types: ONE_OFF_PAYMENT_METHODS,
    line_items: [
      {
        price_data: {
          currency: 'sgd',
          unit_amount: cardCents,
          product_data: { name: `${pkg.name} (${pkg.credits} ${pkg.credits === 1 ? 'session' : 'sessions'})${creditNote}` },
        },
        quantity: 1,
      },
    ],
    // The hold is settled when the webhook / return page grants the pack, and handed back if this checkout
    // expires or fails (checkout.session.expired / async_payment_failed), or after 90 minutes regardless.
    metadata: { ...metadata, ...(holdId ? { credit_hold_id: holdId, credit_cents: String(creditCents) } : {}) },
    // session_id lets the app credit the pack on return even if the Stripe
    // webhook is delayed or misconfigured (see /api/stripe/reconcile).
    success_url: `${origin}/profile?tab=packages&purchase=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/profile?tab=packages&purchase=cancelled`,
  });
  } catch (e) {
    // No checkout exists, so the credit reserved for it would never be used or released.
    await releaseHold(admin, holdId);
    throw e;
  }

  return NextResponse.json({ url: session.url });
}
