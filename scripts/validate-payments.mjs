/**
 * Checkout payment methods + refund/cancellation validation.
 *
 *   npm run dev                            # in another terminal
 *   node scripts/validate-payments.mjs
 *
 * Asserts every one-off checkout offers PayNow first (and card + GrabPay),
 * that subscriptions stay card-capable, and that refunding a paid booking
 * both moves money at Stripe and updates the booking + earnings ledger.
 *
 * Uses real test-mode Stripe objects. Refuses to run against a live key.
 */
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

process.loadEnvFile('.env.local');
const API = process.env.VALIDATE_API_BASE ?? 'http://localhost:3000';
const KEY = process.env.STRIPE_SECRET_KEY ?? '';
if (KEY.startsWith('sk_live')) { console.error('Refusing to run against a live Stripe key.'); process.exit(1); }

const stripe = new Stripe(KEY);
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });

let pass = 0, fail = 0;
const check = (n, ok, d = '') => { console.log(`${ok ? '✅' : '❌'} ${n}${d ? ` — ${d}` : ''}`); ok ? pass++ : fail++; };
const EXPECTED = ['paynow', 'card', 'grabpay'];

const stamp = Date.now();
const password = 'X12345678!';
const vendorEmail = `pay.vendor.${stamp}@babybrain-validation.test`;
const parentEmail = `pay.parent.${stamp}@babybrain-validation.test`;

const { data: vendorU } = await admin.auth.admin.createUser({ email: vendorEmail, password, email_confirm: true });
const { data: parentU } = await admin.auth.admin.createUser({ email: parentEmail, password, email_confirm: true });
const { data: provider } = await admin.from('providers')
  .insert({ owner_id: vendorU.user.id, business_name: `Payments Test Co ${stamp}`, status: 'active', contact_email: vendorEmail })
  .select().single();
await admin.from('provider_members').insert({ provider_id: provider.id, user_id: vendorU.user.id, role: 'owner', status: 'active' });

const { data: activity } = await admin.from('activities')
  .insert({ slug: `pay-act-${stamp}`, title: 'Refund Test Class', category_id: 1, provider_id: provider.id, is_published: true, price: 45 })
  .select().single();
const { data: session } = await admin.from('activity_sessions')
  .insert({ activity_id: activity.id, starts_at: new Date(Date.now() + 9 * 864e5).toISOString(), ends_at: new Date(Date.now() + 9 * 864e5 + 36e5).toISOString() })
  .select().single();
const { data: pkg } = await admin.from('packages')
  .insert({ provider_id: provider.id, name: 'Refund Test Pack', credits: 5, price_cents: 20000, active: true })
  .select().single();

const token = async (email) => (await anon.auth.signInWithPassword({ email, password })).data.session.access_token;
const vendorToken = await token(vendorEmail);
const parentToken = await token(parentEmail);
const hdr = (t) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });

const methodsOf = async (url) => {
  const s = await stripe.checkout.sessions.retrieve(new URL(url).pathname.split('/').pop().split('#')[0]).catch(() => null);
  return s?.payment_method_types ?? null;
};

let bookingId = null;
try {
  // --- 1. Booking checkout ---
  const { data: booking } = await admin.from('bookings')
    .insert({ user_id: parentU.user.id, session_id: session.id }).select().single();
  bookingId = booking.id;
  const bkRes = await fetch(`${API}/api/bookings/checkout`, {
    method: 'POST', headers: hdr(parentToken), body: JSON.stringify({ booking_id: booking.id }),
  });
  const bkBody = await bkRes.json();
  check('Booking checkout created', bkRes.ok, bkBody.error ?? '');
  const bkMethods = bkBody.url ? await methodsOf(bkBody.url) : null;
  check('Booking checkout offers PayNow first, then card, then GrabPay',
    JSON.stringify(bkMethods) === JSON.stringify(EXPECTED), JSON.stringify(bkMethods));

  // --- 2. Package checkout ---
  const pkRes = await fetch(`${API}/api/customer/stripe/package`, {
    method: 'POST', headers: hdr(parentToken), body: JSON.stringify({ package_id: pkg.id }),
  });
  const pkBody = await pkRes.json();
  check('Package checkout created', pkRes.ok, pkBody.error ?? '');
  const pkMethods = pkBody.url ? await methodsOf(pkBody.url) : null;
  check('Package checkout offers PayNow first', JSON.stringify(pkMethods) === JSON.stringify(EXPECTED), JSON.stringify(pkMethods));

  // --- 3. Boost checkout (the one that had no methods set at all) ---
  const boRes = await fetch(`${API}/api/vendor/stripe/boost`, {
    method: 'POST', headers: hdr(vendorToken),
    body: JSON.stringify({ provider_id: provider.id, activity_id: activity.id, days: 14 }),
  });
  const boBody = await boRes.json();
  check('Boost checkout created', boRes.ok, boBody.error ?? '');
  const boMethods = boBody.url ? await methodsOf(boBody.url) : null;
  check('Boost checkout offers PayNow first (was card-only by default)',
    JSON.stringify(boMethods) === JSON.stringify(EXPECTED), JSON.stringify(boMethods));

  // --- 4. Subscriptions must NOT use PayNow (it can't back a recurring charge) ---
  const subSession = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price_data: { currency: 'sgd', unit_amount: 9900, recurring: { interval: 'month' }, product_data: { name: 'Probe plan' } }, quantity: 1 }],
    success_url: 'https://example.com/ok', cancel_url: 'https://example.com/no',
  });
  check('Subscription checkout stays on card-style methods',
    !subSession.payment_method_types.includes('paynow') && !subSession.payment_method_types.includes('grabpay'),
    JSON.stringify(subSession.payment_method_types));
  await stripe.checkout.sessions.expire(subSession.id).catch(() => {});

  // --- 5. Cancellation moves no money (documenting today's behaviour) ---
  await admin.from('bookings').update({ payment_status: 'paid', status: 'confirmed' }).eq('id', booking.id);
  const parentDb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${parentToken}` } }, auth: { persistSession: false },
  });
  await parentDb.rpc('cancel_booking', { p_booking_id: booking.id });
  const { data: cancelled } = await admin.from('bookings').select('status, payment_status').eq('id', booking.id).single();
  check('cancel_booking cancels but does NOT refund', cancelled.status === 'cancelled' && cancelled.payment_status === 'paid',
    `${cancelled.status}/${cancelled.payment_status}`);

  // --- 6. A real charge, then a real refund through our endpoint ---
  const pm = await stripe.paymentMethods.create({ type: 'card', card: { token: 'tok_visa' } });
  const intent = await stripe.paymentIntents.create({
    amount: 4500, currency: 'sgd', payment_method: pm.id, confirm: true,
    automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
  });
  check('Test charge succeeded', intent.status === 'succeeded', intent.status);

  await admin.from('bookings').update({ payment_status: 'paid', status: 'confirmed', stripe_payment_intent: intent.id, amount: 45 }).eq('id', booking.id);
  const { data: earning } = await admin.from('provider_earnings').insert({
    provider_id: provider.id, source: 'booking', booking_id: booking.id, gross_cents: 4500,
    commission_cents: 450, net_cents: 4050, commission_rate: 0.1, fee_payer: 'vendor',
    routed_to_connect: false, stripe_payment_intent: intent.id, status: 'platform_owed',
  }).select().single();

  // Staff-level users must not be able to refund.
  const staffEmail = `pay.staff.${stamp}@babybrain-validation.test`;
  const { data: staffU } = await admin.auth.admin.createUser({ email: staffEmail, password, email_confirm: true });
  await admin.from('provider_members').insert({ provider_id: provider.id, user_id: staffU.user.id, role: 'staff', status: 'active' });
  const staffRes = await fetch(`${API}/api/vendor/bookings/refund`, {
    method: 'POST', headers: hdr(await token(staffEmail)),
    body: JSON.stringify({ provider_id: provider.id, booking_id: booking.id }),
  });
  check('Staff cannot issue refunds', staffRes.status === 403, `HTTP ${staffRes.status}`);
  await admin.auth.admin.deleteUser(staffU.user.id);

  // A refund larger than the sale is rejected.
  const tooBig = await fetch(`${API}/api/vendor/bookings/refund`, {
    method: 'POST', headers: hdr(vendorToken),
    body: JSON.stringify({ provider_id: provider.id, booking_id: booking.id, amount_cents: 999999 }),
  });
  check('Over-refunding is rejected', tooBig.status === 400, `HTTP ${tooBig.status}`);

  // The real thing.
  const refundRes = await fetch(`${API}/api/vendor/bookings/refund`, {
    method: 'POST', headers: hdr(vendorToken),
    body: JSON.stringify({ provider_id: provider.id, booking_id: booking.id }),
  });
  const refundBody = await refundRes.json();
  check('Owner can refund a paid booking', refundRes.ok, refundBody.error ?? '');
  check('Refund is for the full amount', refundBody.amount_cents === 4500, String(refundBody.amount_cents));

  const refreshed = await stripe.paymentIntents.retrieve(intent.id);
  check('Stripe shows the charge refunded', refreshed.status === 'succeeded' && refreshed.amount_received === 4500
    && (await stripe.refunds.list({ payment_intent: intent.id })).data.length === 1);

  const { data: afterBooking } = await admin.from('bookings').select('payment_status, status').eq('id', booking.id).single();
  check('Booking marked refunded + cancelled', afterBooking.payment_status === 'refunded' && afterBooking.status === 'cancelled',
    `${afterBooking.payment_status}/${afterBooking.status}`);

  const { data: afterEarning } = await admin.from('provider_earnings').select('status').eq('id', earning.id).single();
  check('Earnings ledger marks the sale refunded', afterEarning.status === 'refunded', afterEarning.status);

  // Refunding twice is refused by Stripe, not silently double-refunded.
  const again = await fetch(`${API}/api/vendor/bookings/refund`, {
    method: 'POST', headers: hdr(vendorToken),
    body: JSON.stringify({ provider_id: provider.id, booking_id: booking.id }),
  });
  const againBody = await again.json();
  check('Refunding an already-refunded booking is a no-op', again.ok && againBody.amount_cents === 0, JSON.stringify(againBody));

  // --- 7. Another vendor's booking is off limits ---
  const otherEmail = `pay.other.${stamp}@babybrain-validation.test`;
  const { data: otherU } = await admin.auth.admin.createUser({ email: otherEmail, password, email_confirm: true });
  const { data: otherProv } = await admin.from('providers')
    .insert({ owner_id: otherU.user.id, business_name: `Other Co ${stamp}`, status: 'active' }).select().single();
  await admin.from('provider_members').insert({ provider_id: otherProv.id, user_id: otherU.user.id, role: 'owner', status: 'active' });
  const crossRes = await fetch(`${API}/api/vendor/bookings/refund`, {
    method: 'POST', headers: hdr(await token(otherEmail)),
    body: JSON.stringify({ provider_id: otherProv.id, booking_id: booking.id }),
  });
  check('Cannot refund another business s booking', crossRes.status === 404, `HTTP ${crossRes.status}`);
  await admin.from('providers').delete().eq('id', otherProv.id);
  await admin.auth.admin.deleteUser(otherU.user.id);
} finally {
  await admin.from('provider_earnings').delete().eq('provider_id', provider.id);
  if (bookingId) await admin.from('bookings').delete().eq('id', bookingId);
  await admin.from('packages').delete().eq('provider_id', provider.id);
  await admin.from('activities').delete().eq('provider_id', provider.id);
  await admin.from('providers').delete().eq('id', provider.id);
  await admin.auth.admin.deleteUser(vendorU.user.id);
  await admin.auth.admin.deleteUser(parentU.user.id);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
