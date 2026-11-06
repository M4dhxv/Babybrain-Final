import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getStripe, ONE_OFF_PAYMENT_METHODS } from '@/lib/stripe';
import { getAuthedContext } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { appOrigin } from '@/lib/cors';
import { computeSplit, getTerms } from '@/lib/commercials';

/**
 * Parent pays a monthly invoice (migration 00268). The amount comes from the
 * invoice row, never from the client. One-off Stripe Checkout; when the
 * provider has completed Stripe Connect the charge is split to their account
 * with the platform commission as an application fee, exactly like a booking.
 * On payment the webhook (kind='monthly_invoice') marks the invoice paid, and
 * /api/stripe/reconcile does the same when the parent returns.
 * Body: { invoice_id: string }
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { invoice_id?: string };
  if (!body.invoice_id) {
    return NextResponse.json({ error: 'invoice_id required' }, { status: 400 });
  }

  const { user } = await getAuthedContext(request);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const admin = createAdminClient();
  const db = admin as unknown as SupabaseClient;
  const { data: invoice } = await db
    .from('monthly_invoices')
    .select('id, user_id, provider_id, status, amount_cents, session_count, period_start, stripe_checkout_session_id, activities(title)')
    .eq('id', body.invoice_id)
    .maybeSingle();
  if (!invoice || invoice.user_id !== user.id) {
    return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
  }
  if (invoice.status === 'paid') return NextResponse.json({ error: 'Already paid' }, { status: 409 });
  if (invoice.status !== 'open') return NextResponse.json({ error: 'This invoice is no longer payable' }, { status: 409 });

  const stripe = getStripe();

  // A parent who taps Pay twice (or comes back to it) is taken to the checkout that is already
  // open, not given a second one they could also pay.
  if (invoice.stripe_checkout_session_id) {
    const prior = await stripe.checkout.sessions.retrieve(invoice.stripe_checkout_session_id).catch(() => null);
    if (prior?.status === 'open' && prior.url) return NextResponse.json({ url: prior.url });
    if (prior?.payment_status === 'paid') {
      return NextResponse.json({ error: 'This payment is being processed — please check back in a moment.' }, { status: 409 });
    }
  }

  const title = (invoice.activities as unknown as { title: string } | null)?.title ?? 'Monthly class';
  const monthLabel = new Date(`${invoice.period_start}T00:00:00+08:00`).toLocaleDateString('en-SG', {
    month: 'long',
    year: 'numeric',
    timeZone: 'Asia/Singapore',
  });
  const origin = appOrigin(request);

  let connect = {};
  const { data: provider } = await admin
    .from('providers')
    .select('stripe_account_id, payouts_enabled')
    .eq('id', invoice.provider_id)
    .maybeSingle();
  if (provider?.stripe_account_id && provider.payouts_enabled) {
    const terms = await getTerms(admin, invoice.provider_id);
    const split = computeSplit(invoice.amount_cents, terms);
    connect = {
      payment_intent_data: {
        application_fee_amount: split.applicationFeeCents,
        transfer_data: { destination: provider.stripe_account_id },
      },
    };
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    ...connect,
    payment_method_types: ONE_OFF_PAYMENT_METHODS,
    line_items: [
      {
        price_data: {
          currency: 'sgd',
          unit_amount: invoice.amount_cents,
          product_data: {
            name: `${title} — ${monthLabel} (${invoice.session_count} ${invoice.session_count === 1 ? 'session' : 'sessions'})`,
          },
        },
        quantity: 1,
      },
    ],
    metadata: { kind: 'monthly_invoice', invoice_id: invoice.id, user_id: user.id },
    // session_id lets the app mark the invoice paid on return even if the Stripe webhook is
    // delayed or misconfigured (see /api/stripe/reconcile).
    success_url: `${origin}/profile?tab=monthly&paid=1&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/profile?tab=monthly`,
  });

  await db.from('monthly_invoices').update({ stripe_checkout_session_id: session.id }).eq('id', invoice.id);
  return NextResponse.json({ url: session.url });
}
