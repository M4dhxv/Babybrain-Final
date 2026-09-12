/**
 * Parent "Plus" plan validation — hits the live customer subscription and
 * portal routes on a running dev server with a real Bearer token, against
 * Stripe TEST mode.
 *
 *   npm run dev                              # in another terminal
 *   node scripts/validate-parent-plan.mjs
 *
 * The vendor side got all of this in Aug 2026 (validate-plan-changes.mjs);
 * the parent side never did, and three bugs had been sitting in it:
 *
 *  1. `trial_period_days` was passed unconditionally, so cancel → resubscribe
 *     handed out another free 30 days, indefinitely.
 *  2. The re-buy guard read `customer_subscriptions.plan`, which only the
 *     webhook writes — so a second click before it landed minted a second
 *     subscription. One test parent had four live at once.
 *  3. A parent on Plus monthly could not move to annual from either side: the
 *     route 409'd, and the portal ran on Stripe's default configuration where
 *     `subscription_update` is disabled.
 *
 * Creates a throwaway parent + Stripe customer and cleans both up. Refuses to
 * run against a live Stripe key.
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

const { data: cfgRows } = await admin
  .from('app_config')
  .select('key, value')
  .in('key', ['stripe_plus_price_id', 'stripe_plus_price_id_annual', 'stripe_parent_portal_configuration_id']);
const cfg = Object.fromEntries((cfgRows ?? []).map((r) => [r.key, r.value]));
const MONTHLY = cfg.stripe_plus_price_id;
const ANNUAL = cfg.stripe_plus_price_id_annual;
if (!MONTHLY || !ANNUAL) {
  console.error('Plus monthly/annual price ids are not configured in app_config.');
  process.exit(1);
}

const stamp = Date.now();
const email = `plus.parent.${stamp}@babybrain-validation.test`;
const password = 'X12345678!';

const { data: parent } = await admin.auth.admin.createUser({ email, password, email_confirm: true });

const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});
const { data: signIn, error: signInError } = await anon.auth.signInWithPassword({ email, password });
if (!signIn?.session) {
  // Usually Supabase auth rate-limiting after several runs in quick
  // succession. Fail loudly rather than letting every assertion below report
  // a confusing "Not authenticated".
  console.error(`Could not sign the test parent in: ${signInError?.message ?? 'no session returned'}`);
  await admin.auth.admin.deleteUser(parent.user.id);
  process.exit(1);
}
const headers = { Authorization: `Bearer ${signIn.session.access_token}`, 'Content-Type': 'application/json' };

const subscribe = (billing) =>
  fetch(`${API}/api/customer/stripe/subscription`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ billing }),
  }).then(async (r) => ({ r, body: await r.json() }));

const portal = (hdrs = headers) =>
  fetch(`${API}/api/customer/stripe/portal`, { method: 'POST', headers: hdrs })
    .then(async (r) => ({ r, body: await r.json() }));

const sessionIdOf = (url) => (String(url).match(/cs_(?:test|live)_[A-Za-z0-9]+/) ?? [])[0];

/**
 * Whether a checkout session grants the free trial. `subscription_data` is a
 * create-only parameter and is not returned when the session is read back, so
 * the trial is asserted through what it does to the price: a trialing checkout
 * collects nothing up front, a normal one collects the first period.
 */
const grantsTrial = (session) => session.amount_total === 0;

const LIVE = ['active', 'trialing', 'past_due', 'unpaid'];
const liveSubs = async (customerId) => {
  const all = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 });
  return all.data.filter((s) => LIVE.includes(s.status));
};

/** Mirrors liveSubscriptionFor(…, 'user_id', …) in the Stripe webhook. */
const surviving = async (ended, userId) => {
  const all = await stripe.subscriptions.list({ customer: ended.customer, status: 'all', limit: 100 });
  return (
    all.data
      .filter((s) => s.id !== ended.id)
      .filter((s) => s.metadata?.user_id === userId)
      .filter((s) => LIVE.includes(s.status))
      .sort((a, b) => a.created - b.created)[0] ?? null
  );
};

const row = async () =>
  (await admin
    .from('customer_subscriptions')
    .select('plan, billing_interval, status, stripe_customer_id, stripe_subscription_id')
    .eq('user_id', parent.user.id)
    .maybeSingle()).data;

let customerId = null;
try {
  // --- 1. First time: a checkout link, and it carries the free trial ---
  const first = await subscribe('monthly');
  check('First subscribe returns a Stripe Checkout URL',
    String(first.body?.url ?? '').startsWith('https://checkout.stripe.com/'), first.body?.error ?? '');

  const created = await row();
  customerId = created?.stripe_customer_id;
  check('Stripe customer stored on the customer_subscriptions row', Boolean(customerId), customerId ?? 'none');
  check('…and the requested interval is recorded up front', created?.billing_interval === 'monthly', created?.billing_interval ?? 'none');

  if (!sessionIdOf(first.body.url)) throw new Error(`No checkout session in the response: ${JSON.stringify(first.body)}`);
  const session = await stripe.checkout.sessions.retrieve(sessionIdOf(first.body.url));
  check('First-time checkout collects nothing up front (the 30-day trial)',
    grantsTrial(session), `amount_total ${session.amount_total}`);
  check('…and it is the monthly Plus price', session.amount_total === 0, `amount_total ${session.amount_total}`);
  await stripe.checkout.sessions.expire(session.id).catch(() => {});

  // --- 2. Stand up a live monthly subscription, as a completed checkout would ---
  const monthlySub = await stripe.subscriptions.create({
    customer: customerId,
    items: [{ price: MONTHLY }],
    trial_period_days: 30,
    metadata: { user_id: parent.user.id, billing: 'monthly' },
  });
  await admin
    .from('customer_subscriptions')
    .update({ plan: 'plus', stripe_subscription_id: monthlySub.id, status: 'trialing' })
    .eq('user_id', parent.user.id);

  // --- 3. Asking for the interval you already hold ---
  const same = await subscribe('monthly');
  check('Re-buying the current interval is refused', same.r.status === 409, `HTTP ${same.r.status}`);
  check('…with a code the UI can act on', same.body?.code === 'already_on_plan', JSON.stringify(same.body));
  check('…and no second subscription is created', (await liveSubs(customerId)).length === 1,
    `${(await liveSubs(customerId)).length} live`);

  // --- 4. Monthly → annual switches in place, no second subscription ---
  const toAnnual = await subscribe('annual');
  check('Switching to annual switches in place (no checkout redirect)',
    toAnnual.body?.switched === true && !toAnnual.body?.url, JSON.stringify(toAnnual.body));
  check('Still exactly one live subscription', (await liveSubs(customerId)).length === 1,
    `${(await liveSubs(customerId)).length} live`);

  const afterAnnual = (await liveSubs(customerId))[0];
  check('It is now billing the annual Plus price', afterAnnual.items.data[0]?.price?.id === ANNUAL,
    afterAnnual.items.data[0]?.price?.id);
  check('Its metadata moved to annual too', afterAnnual.metadata?.billing === 'annual', afterAnnual.metadata?.billing);
  const annualRow = await row();
  check('Database billing_interval says annual', annualRow?.billing_interval === 'annual', annualRow?.billing_interval);
  check('…and the plan is still Plus', annualRow?.plan === 'plus', annualRow?.plan);

  // --- 5. …and back again ---
  const toMonthly = await subscribe('monthly');
  check('Switching back to monthly switches in place', toMonthly.body?.switched === true, JSON.stringify(toMonthly.body));
  check('It is back on the monthly Plus price',
    (await liveSubs(customerId))[0].items.data[0]?.price?.id === MONTHLY,
    (await liveSubs(customerId))[0].items.data[0]?.price?.id);
  check('Database billing_interval says monthly', (await row())?.billing_interval === 'monthly', (await row())?.billing_interval);

  // --- 6. The webhook's last-one-standing rule, parent side ---
  // Trialing, like the one above: Stripe refuses to create a subscription
  // that bills immediately for a customer with no payment method attached,
  // and a test customer never has one.
  const second = await stripe.subscriptions.create({
    customer: customerId,
    items: [{ price: ANNUAL }],
    trial_period_days: 30,
    metadata: { user_id: parent.user.id, billing: 'annual' },
  });
  const ended = await stripe.subscriptions.cancel(second.id, { prorate: false });
  check('Cancelling one of two subscriptions leaves the other as the plan',
    (await surviving(ended, parent.user.id)) !== null,
    (await surviving(ended, parent.user.id))?.id ?? 'none');

  // --- 7. No second free trial for a returning parent ---
  for (const s of await liveSubs(customerId)) await stripe.subscriptions.cancel(s.id, { prorate: false });
  await admin
    .from('customer_subscriptions')
    .update({ plan: 'free', status: 'canceled', stripe_subscription_id: null })
    .eq('user_id', parent.user.id);

  const returning = await subscribe('monthly');
  check('After cancelling, a returning parent gets a checkout link again',
    String(returning.body?.url ?? '').startsWith('https://checkout.stripe.com/'), returning.body?.error ?? '');
  const returnSession = await stripe.checkout.sessions.retrieve(sessionIdOf(returning.body.url));
  check('…but NOT another free trial — the first period is charged',
    !grantsTrial(returnSession), `amount_total ${returnSession.amount_total}`);
  await stripe.checkout.sessions.expire(returnSession.id).catch(() => {});

  // --- 8. Billing portal ---
  const p = await portal();
  check('Billing portal returns a hosted URL',
    String(p.body?.url ?? '').startsWith('https://billing.stripe.com/'), p.body?.error ?? '');
  if (cfg.stripe_parent_portal_configuration_id) {
    const psession = await stripe.billingPortal.sessions.create({
      customer: customerId,
      configuration: cfg.stripe_parent_portal_configuration_id,
    });
    check('Parent portal configuration allows plan changes',
      psession.configuration === cfg.stripe_parent_portal_configuration_id,
      String(psession.configuration));
    const conf = await stripe.billingPortal.configurations.retrieve(cfg.stripe_parent_portal_configuration_id);
    check('…subscription_update is enabled on it', conf.features.subscription_update.enabled === true,
      String(conf.features.subscription_update.enabled));
  } else {
    check('Parent portal configuration is pinned in app_config', false,
      'stripe_parent_portal_configuration_id missing — run `npm run stripe:portal -- --apply`');
  }

  // --- 9. Auth ---
  const anonCall = await fetch(`${API}/api/customer/stripe/subscription`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ billing: 'monthly' }),
  });
  check('Unauthenticated subscribe is refused', anonCall.status === 401, `HTTP ${anonCall.status}`);
  const anonPortal = await fetch(`${API}/api/customer/stripe/portal`, { method: 'POST' });
  check('Unauthenticated portal is refused', anonPortal.status === 401, `HTTP ${anonPortal.status}`);
} finally {
  if (customerId) {
    for (const s of await liveSubs(customerId)) await stripe.subscriptions.cancel(s.id, { prorate: false }).catch(() => {});
    await stripe.customers.del(customerId).catch(() => {});
  }
  await admin.from('customer_subscriptions').delete().eq('user_id', parent.user.id);
  await admin.auth.admin.deleteUser(parent.user.id);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
