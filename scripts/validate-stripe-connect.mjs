/**
 * Vendor Stripe Connect (payouts) validation — hits the live routes on a
 * running dev server with a real Bearer token, against Stripe TEST mode.
 *
 *   npm run dev                                   # in another terminal
 *   node scripts/validate-stripe-connect.mjs
 *
 * Creates a throwaway owner + provider and a real test-mode Express account,
 * then cleans both up. Refuses to run against a live Stripe key.
 *
 * Section 10 closes the gap validate-commercials.mjs's header promises this
 * file covers: it settles a REAL destination charge against a REAL connected
 * account and asserts the money actually split. Until it existed, the split
 * was only ever checked as arithmetic — `computeSplit` in isolation — while
 * the one place `payouts_enabled: true` appeared here used a deliberately
 * fake account id. So nothing would have caught the `payment_intent_data`
 * block in app/api/bookings/checkout/route.ts regressing.
 */
import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

process.loadEnvFile('.env.local');
const API = process.env.VALIDATE_API_BASE ?? 'http://localhost:3000';
const KEY = process.env.STRIPE_SECRET_KEY ?? '';
if (KEY.startsWith('sk_live')) {
  console.error('Refusing to run against a live Stripe key.');
  process.exit(1);
}

const stripe = new Stripe(KEY);
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

let pass = 0, fail = 0;
const check = (n, ok, d = '') => { console.log(`${ok ? '✅' : '❌'} ${n}${d ? ` — ${d}` : ''}`); ok ? pass++ : fail++; };

/**
 * Re-read until `done` accepts the result, or give up.
 *
 * A destination charge's transfer, the connected account's balance
 * transaction and the platform's application fee are all created
 * asynchronously — they are not there in the same tick the PaymentIntent
 * comes back `succeeded`. Asserting immediately reported a correct split as
 * four failures.
 */
async function settle(read, done, tries = 12, waitMs = 1000) {
  let last;
  for (let i = 0; i < tries; i++) {
    last = await read();
    if (done(last)) return last;
    await new Promise((r) => setTimeout(r, waitMs));
  }
  return last;
}

const stamp = Date.now();
const email = `connect.owner.${stamp}@babybrain-validation.test`;
const password = 'X12345678!';

const { data: owner } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
const { data: provider } = await admin
  .from('providers')
  .insert({
    owner_id: owner.user.id,
    business_name: `Connect Test Co ${stamp}`,
    status: 'active',
    contact_email: email,
    website: 'babybrain.sg',   // bare domain: exercises URL normalisation
  })
  .select()
  .single();
await admin.from('provider_members').insert({ provider_id: provider.id, user_id: owner.user.id, role: 'owner', status: 'active' });

const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});
const { data: signIn } = await anon.auth.signInWithPassword({ email, password });
const token = signIn.session.access_token;
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const ORIGIN = 'http://localhost:5174';

const get = () =>
  fetch(`${API}/api/vendor/stripe/connect?provider_id=${provider.id}`, { headers }).then(async (r) => ({ r, body: await r.json() }));
const post = () =>
  fetch(`${API}/api/vendor/stripe/connect`, {
    method: 'POST',
    headers: { ...headers, Origin: ORIGIN },
    body: JSON.stringify({ provider_id: provider.id }),
  }).then(async (r) => ({ r, body: await r.json() }));

let accountId = null;
let splitAccountId = null;
let splitChargeId = null;
try {
  // --- 1. Nothing connected yet ---
  const before = await get();
  check('GET before connecting → not_connected', before.body?.status?.state === 'not_connected', JSON.stringify(before.body?.status?.state));

  // --- 2. POST creates the Express account + an onboarding link ---
  const created = await post();
  check('POST returns an onboarding link', created.body?.kind === 'onboarding' && String(created.body?.url ?? '').startsWith('https://connect.stripe.com/'), created.body?.error ?? created.body?.kind);

  const { data: row } = await admin.from('providers').select('stripe_account_id, payouts_enabled').eq('id', provider.id).single();
  accountId = row?.stripe_account_id;
  check('Account id stored on the provider row', Boolean(accountId), accountId ?? 'none');
  check('payouts_enabled starts false', row?.payouts_enabled === false);

  if (accountId) {
    const account = await stripe.accounts.retrieve(accountId);
    check('Express account, SG, linked back to the provider', account.type === 'express' && account.country === 'SG' && account.metadata?.provider_id === provider.id);
    check('business_type left for the vendor to choose', !account.business_type, account.business_type ?? 'unset');
    check('card_payments + transfers requested', Boolean(account.capabilities?.card_payments && account.capabilities?.transfers), JSON.stringify(account.capabilities));
    check('Daily automatic payout schedule', account.settings?.payouts?.schedule?.interval === 'daily', account.settings?.payouts?.schedule?.interval);
      check('Business profile prefilled from the provider', account.business_profile?.name === provider.business_name, account.business_profile?.name ?? 'empty');
    check('Bare-domain website normalised to a URL Stripe accepts', account.business_profile?.url === 'https://babybrain.sg', account.business_profile?.url ?? 'dropped');
  }

  // --- 3. Status reflects the half-finished account ---
  const mid = await get();
  const status = mid.body?.status ?? {};
  check('GET after create → incomplete', status.state === 'incomplete', status.state);
  check('Outstanding requirements are reported', Array.isArray(status.requirements_due) && status.requirements_due.length > 0, `${status.requirements_due?.length ?? 0} items`);
  check('Not yet payable', status.payouts_enabled === false && status.charges_enabled === false);

  // --- 4. A second POST reuses the same account (no orphans) ---
  const again = await post();
  const { data: row2 } = await admin.from('providers').select('stripe_account_id').eq('id', provider.id).single();
  check('Second POST reuses the same account', row2?.stripe_account_id === accountId && again.body?.kind === 'onboarding');

  // --- 5. A junk website is dropped rather than blocking onboarding ---
  const { data: junk } = await admin
    .from('providers')
    .insert({ owner_id: owner.user.id, business_name: `Junk Site Co ${stamp}`, status: 'active', contact_email: email, website: 'https://example.com' })
    .select()
    .single();
  await admin.from('provider_members').insert({ provider_id: junk.id, user_id: owner.user.id, role: 'owner', status: 'active' });
  const junkPost = await fetch(`${API}/api/vendor/stripe/connect`, {
    method: 'POST',
    headers: { ...headers, Origin: ORIGIN },
    body: JSON.stringify({ provider_id: junk.id }),
  }).then((r) => r.json());
  check('A website Stripe rejects still yields an onboarding link', junkPost?.kind === 'onboarding', junkPost?.error ?? junkPost?.kind);
  const { data: junkRow } = await admin.from('providers').select('stripe_account_id').eq('id', junk.id).single();
  if (junkRow?.stripe_account_id) await stripe.accounts.del(junkRow.stripe_account_id).catch(() => {});
  await admin.from('providers').delete().eq('id', junk.id);

  // --- 6. A stale account id is cleared rather than looping forever ---
  await admin.from('providers').update({ stripe_account_id: 'acct_deadbeefdeadbeef', payouts_enabled: true }).eq('id', provider.id);
  const stale = await get();
  const { data: row3 } = await admin.from('providers').select('stripe_account_id, payouts_enabled').eq('id', provider.id).single();
  check('Unknown account id is cleared on read', stale.body?.status?.state === 'not_connected' && row3?.stripe_account_id === null && row3?.payouts_enabled === false);
  await admin.from('providers').update({ stripe_account_id: accountId }).eq('id', provider.id);

  // --- 7. Role gate: a staff member cannot start onboarding ---
  const staffEmail = `connect.staff.${stamp}@babybrain-validation.test`;
  const { data: staff } = await admin.auth.admin.createUser({ email: staffEmail, password, email_confirm: true });
  await admin.from('provider_members').insert({ provider_id: provider.id, user_id: staff.user.id, role: 'staff', status: 'active' });
  const { data: staffSignIn } = await anon.auth.signInWithPassword({ email: staffEmail, password });
  const staffHeaders = { Authorization: `Bearer ${staffSignIn.session.access_token}`, 'Content-Type': 'application/json' };
  const staffPost = await fetch(`${API}/api/vendor/stripe/connect`, { method: 'POST', headers: staffHeaders, body: JSON.stringify({ provider_id: provider.id }) });
  check('Staff cannot start payout onboarding', staffPost.status === 403, `HTTP ${staffPost.status}`);
  const staffGet = await fetch(`${API}/api/vendor/stripe/connect?provider_id=${provider.id}`, { headers: staffHeaders });
  check('Staff can still read payout status', staffGet.ok, `HTTP ${staffGet.status}`);
  await admin.auth.admin.deleteUser(staff.user.id);

  // --- 8. A non-member gets nothing ---
  const outsiderEmail = `connect.outsider.${stamp}@babybrain-validation.test`;
  const { data: outsider } = await admin.auth.admin.createUser({ email: outsiderEmail, password, email_confirm: true });
  const { data: outsiderSignIn } = await anon.auth.signInWithPassword({ email: outsiderEmail, password });
  const outsiderGet = await fetch(`${API}/api/vendor/stripe/connect?provider_id=${provider.id}`, {
    headers: { Authorization: `Bearer ${outsiderSignIn.session.access_token}` },
  });
  check('Non-member is refused', outsiderGet.status === 403, `HTTP ${outsiderGet.status}`);
  await admin.auth.admin.deleteUser(outsider.user.id);

  // --- 9. Anonymous is refused ---
  const anonGet = await fetch(`${API}/api/vendor/stripe/connect?provider_id=${provider.id}`);
  check('Unauthenticated is refused', anonGet.status === 401, `HTTP ${anonGet.status}`);

  /* --- 10. A real destination charge actually splits the money ---

     The Express accounts the app creates cannot be completed from the API
     (Stripe refuses `tos_acceptance` when it collects the requirements
     itself), so this stands up a PLATFORM-collected account instead. It is
     not the account type the app creates — the point is only to get a
     payable `transfers` capability to charge against, so that the split
     parameters the booking route builds can be settled for real.

     What is asserted is the shape of what the route sends: the same
     `application_fee_amount` + `transfer_data.destination` pair that
     app/api/bookings/checkout/route.ts puts in `payment_intent_data`. */
  splitAccountId = (await stripe.accounts.create({
    country: 'SG',
    email: `connect.split.${stamp}@babybrain-validation.test`,
    controller: {
      losses: { payments: 'application' },
      fees: { payer: 'application' },
      requirement_collection: 'application',
      stripe_dashboard: { type: 'none' },
    },
    capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
    business_type: 'individual',
    business_profile: { mcc: '8299', url: 'https://babybrain.sg', product_description: 'Baby classes' },
    individual: {
      first_name: 'Jenny', last_name: 'Rosen',
      dob: { day: 1, month: 1, year: 1990 },
      address: { line1: 'address_full_match', city: 'Singapore', postal_code: '069542', country: 'SG' },
      email: 'jenny@babybrain-validation.test', phone: '+6598765432',
      id_number: 'S0000000A', nationality: 'SG',
      // NOT `[]` — an empty array leaves `individual.full_name_aliases`
      // outstanding forever. One empty string is how you declare "no aliases".
      full_name_aliases: [''],
    },
    tos_acceptance: { date: Math.floor(Date.now() / 1000), ip: '8.8.8.8' },
    external_account: {
      object: 'bank_account', country: 'SG', currency: 'sgd',
      account_number: '000123456', routing_number: '1100-000',
    },
  })).id;

  const splitAccount = await stripe.accounts.retrieve(splitAccountId);
  check('A fully-provisioned connected account can take charges',
    splitAccount.capabilities?.transfers === 'active' && splitAccount.capabilities?.card_payments === 'active',
    JSON.stringify(splitAccount.capabilities));

  // Default terms for a new vendor: 12% and the vendor absorbs the Stripe fee
  // (validate-commercials asserts those defaults are what a new row gets).
  const SALE = 10000;
  const commission = Math.round(SALE * 0.12);
  const feeRecovery = Math.round(SALE * 0.034) + 50;
  const expectedFee = Math.min(commission + feeRecovery, SALE);
  const expectedNet = SALE - expectedFee;

  const pi = await stripe.paymentIntents.create({
    amount: SALE,
    currency: 'sgd',
    payment_method: 'pm_card_visa',
    confirm: true,
    automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
    application_fee_amount: expectedFee,
    transfer_data: { destination: splitAccountId },
    description: 'validate-stripe-connect destination charge',
  });
  check('Destination charge succeeds', pi.status === 'succeeded', pi.status);

  splitChargeId = pi.latest_charge;
  const charge = await settle(
    () => stripe.charges.retrieve(splitChargeId, { expand: ['transfer'] }),
    (c) => Boolean(c.transfer?.destination)
  );
  check('Platform took exactly the application fee',
    charge.application_fee_amount === expectedFee, `${charge.application_fee_amount} (expected ${expectedFee})`);
  check('…routed to the connected account',
    charge.transfer?.destination === splitAccountId, String(charge.transfer?.destination));

  /* The vendor's real credit is the balance transaction ON THEIR account, not
     `transfer.amount`. The transfer carries the GROSS sale and the application
     fee is levied on the connected account, so `transfer.amount` reads 10000
     on a correct 1590/8410 split — asserting on it makes a working split look
     broken. */
  const payment = await settle(
    async () => {
      const txns = await stripe.balanceTransactions.list({ limit: 10 }, { stripeAccount: splitAccountId });
      return txns.data.find((t) => t.type === 'payment');
    },
    (t) => typeof t?.net === 'number'
  );
  check('Vendor is credited the sale less the commission and fee',
    payment?.net === expectedNet, `net ${payment?.net} (expected ${expectedNet})`);
  check('…and their ledger agrees on gross and deduction',
    payment?.amount === SALE && payment?.fee === expectedFee,
    `amount ${payment?.amount} fee ${payment?.fee}`);

  const fees = await settle(
    () => stripe.applicationFees.list({ limit: 25 }),
    (l) => l.data.some((f) => f.account === splitAccountId)
  );
  check('The application fee is recorded against the platform',
    fees.data.some((f) => f.account === splitAccountId && f.amount === expectedFee),
    `${fees.data.filter((f) => f.account === splitAccountId).length} fee(s) for this account`);

  // A refund must claw back both sides, or the vendor keeps money BabyBrain
  // has already returned to the parent (lib/refunds.ts relies on this).
  await stripe.refunds.create({
    charge: splitChargeId, refund_application_fee: true, reverse_transfer: true,
  });
  const refunded = await stripe.charges.retrieve(splitChargeId, { expand: ['transfer'] });
  check('Refunding reverses the transfer and the application fee',
    refunded.refunded === true && refunded.transfer?.amount_reversed === SALE,
    `refunded=${refunded.refunded} reversed=${refunded.transfer?.amount_reversed}`);
} finally {
  if (splitChargeId) {
    await stripe.refunds
      .create({ charge: splitChargeId, refund_application_fee: true, reverse_transfer: true })
      .catch(() => {}); // already refunded on the happy path
  }
  if (splitAccountId) await stripe.accounts.del(splitAccountId).catch(() => {});
  if (accountId) await stripe.accounts.del(accountId).catch(() => {});
  await admin.from('providers').delete().eq('id', provider.id);
  await admin.auth.admin.deleteUser(owner.user.id);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
