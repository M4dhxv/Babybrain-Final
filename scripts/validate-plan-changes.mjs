/**
 * Vendor plan-change validation — hits the live subscription route on a
 * running dev server with a real Bearer token, against Stripe TEST mode.
 *
 *   npm run dev                               # in another terminal
 *   node scripts/validate-plan-changes.mjs
 *
 * Covers the QA 23/08 row ("if you are already on the Pro plan you shouldn't
 * be able to get to stripe payment to upgrade to the plan you are already
 * on") and the subscription-stacking bug found underneath it: the route used
 * to mint a brand-new subscription on every click, so one demo vendor ended
 * up with nine live subscriptions at once.
 *
 * Creates a throwaway owner + provider + Stripe customer and cleans all of
 * them up. Refuses to run against a live Stripe key.
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
  .in('key', ['stripe_growth_price_id', 'stripe_pro_price_id']);
const cfg = Object.fromEntries((cfgRows ?? []).map((r) => [r.key, r.value]));
const GROWTH = cfg.stripe_growth_price_id;
const PRO = cfg.stripe_pro_price_id;
if (!GROWTH || !PRO) {
  console.error('Growth/Pro price ids are not configured in app_config.');
  process.exit(1);
}

const stamp = Date.now();
const email = `plan.owner.${stamp}@babybrain-validation.test`;
const password = 'X12345678!';

const { data: owner } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
const { data: provider } = await admin
  .from('providers')
  .insert({ owner_id: owner.user.id, business_name: `Plan Test Co ${stamp}`, status: 'active', contact_email: email })
  .select()
  .single();
await admin.from('provider_members').insert({ provider_id: provider.id, user_id: owner.user.id, role: 'owner', status: 'active' });

const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});
const { data: signIn, error: signInError } = await anon.auth.signInWithPassword({ email, password });
if (!signIn?.session) {
  // Usually Supabase auth rate-limiting after several runs in quick
  // succession. Fail loudly here rather than letting every later assertion
  // report a confusing "Not authenticated".
  console.error(`Could not sign the test owner in: ${signInError?.message ?? 'no session returned'}`);
  await admin.from('providers').delete().eq('id', provider.id);
  await admin.auth.admin.deleteUser(owner.user.id);
  process.exit(1);
}
const headers = { Authorization: `Bearer ${signIn.session.access_token}`, 'Content-Type': 'application/json' };
const ORIGIN = 'http://localhost:5174';

const subscribe = (plan) =>
  fetch(`${API}/api/vendor/stripe/subscription`, {
    method: 'POST',
    headers: { ...headers, Origin: ORIGIN },
    body: JSON.stringify({ provider_id: provider.id, plan }),
  }).then(async (r) => ({ r, body: await r.json() }));

/** Checkout URLs look like https://checkout.stripe.com/c/pay/cs_test_...#fid... */
const sessionIdOf = (url) => (String(url).match(/cs_(?:test|live)_[A-Za-z0-9]+/) ?? [])[0];

/**
 * Whether a checkout session grants the free trial. `subscription_data` is a
 * create-only parameter and is not returned when the session is read back, so
 * the trial is asserted through what it actually does to the price: a trialing
 * subscription checkout collects nothing up front (amount_total 0), a normal
 * one collects the first period.
 */
const grantsTrial = (session) => session.amount_total === 0;

const liveSubs = async (customerId) => {
  const all = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 });
  return all.data.filter((s) => ['active', 'trialing', 'past_due', 'unpaid'].includes(s.status));
};

let customerId = null;
try {
  // --- 1. First time: a checkout link, and it carries the free trial ---
  const first = await subscribe('growth');
  check('First subscribe returns a Stripe Checkout URL',
    String(first.body?.url ?? '').startsWith('https://checkout.stripe.com/'), first.body?.error ?? '');

  const { data: row } = await admin.from('subscriptions').select('stripe_customer_id').eq('provider_id', provider.id).single();
  customerId = row?.stripe_customer_id;
  check('Stripe customer stored on the subscriptions row', Boolean(customerId), customerId ?? 'none');

  if (!sessionIdOf(first.body.url)) throw new Error(`No checkout session in the response: ${JSON.stringify(first.body)}`);
  const session = await stripe.checkout.sessions.retrieve(sessionIdOf(first.body.url));
  check('First-time checkout collects nothing up front (the 30-day trial)',
    grantsTrial(session), `amount_total ${session.amount_total}`);
  await stripe.checkout.sessions.expire(session.id).catch(() => {});

  // --- 2. Stand up a live Growth subscription, as a completed checkout would ---
  const growthSub = await stripe.subscriptions.create({
    customer: customerId,
    items: [{ price: GROWTH }],
    trial_period_days: 30,
    metadata: { provider_id: provider.id, plan: 'growth' },
  });
  await admin.from('subscriptions').update({ plan: 'growth', stripe_subscription_id: growthSub.id, status: 'trialing' }).eq('provider_id', provider.id);

  // --- 3. The bug from the QA sheet: asking for the plan you already hold ---
  const same = await subscribe('growth');
  check('Re-buying the current plan is refused', same.r.status === 409, `HTTP ${same.r.status}`);
  check('…with a code the UI can act on', same.body?.code === 'already_on_plan', JSON.stringify(same.body?.code));
  check('…and no second subscription is created', (await liveSubs(customerId)).length === 1,
    `${(await liveSubs(customerId)).length} live`);

  // --- 4. Upgrading moves the existing subscription rather than stacking ---
  const up = await subscribe('pro');
  check('Upgrade switches in place (no checkout redirect)', up.body?.switched === true && !up.body?.url, JSON.stringify(up.body));
  const afterUp = await liveSubs(customerId);
  check('Still exactly one live subscription', afterUp.length === 1, `${afterUp.length} live`);
  check('It is now billing the Pro price', afterUp[0]?.items.data[0]?.price?.id === PRO, afterUp[0]?.items.data[0]?.price?.id);
  check('Its metadata moved to Pro too (so the webhook records the right tier)',
    afterUp[0]?.metadata?.plan === 'pro', afterUp[0]?.metadata?.plan);
  const { data: afterUpRow } = await admin.from('subscriptions').select('plan').eq('provider_id', provider.id).single();
  check('Database plan says pro', afterUpRow?.plan === 'pro', afterUpRow?.plan);

  // --- 5. Downgrading works the same way ("Can't downgrade anywhere") ---
  const down = await subscribe('growth');
  check('Downgrade switches in place', down.body?.switched === true, JSON.stringify(down.body));
  const afterDown = await liveSubs(customerId);
  check('Still exactly one live subscription', afterDown.length === 1, `${afterDown.length} live`);
  check('It is back on the Growth price', afterDown[0]?.items.data[0]?.price?.id === GROWTH, afterDown[0]?.items.data[0]?.price?.id);
  const { data: afterDownRow } = await admin.from('subscriptions').select('plan').eq('provider_id', provider.id).single();
  check('Database plan says growth', afterDownRow?.plan === 'growth', afterDownRow?.plan);

  // --- 6. Now on Pro's old seat: asking for Pro again is refused, not stacked ---
  await stripe.subscriptions.cancel(afterDown[0].id, { prorate: false });
  const returning = await subscribe('pro');
  check('After cancelling, a returning vendor gets a checkout link again',
    String(returning.body?.url ?? '').startsWith('https://checkout.stripe.com/'), returning.body?.error ?? '');
  const returnSession = await stripe.checkout.sessions.retrieve(sessionIdOf(returning.body.url));
  check('…but NOT another free trial — the first period is charged',
    !grantsTrial(returnSession) && returnSession.amount_total > 0,
    `amount_total ${returnSession.amount_total}`);
  await stripe.checkout.sessions.expire(returnSession.id).catch(() => {});

  // --- 7. Only an owner may change the plan ---
  const staffEmail = `plan.staff.${stamp}@babybrain-validation.test`;
  const { data: staff } = await admin.auth.admin.createUser({ email: staffEmail, password, email_confirm: true });
  await admin.from('provider_members').insert({ provider_id: provider.id, user_id: staff.user.id, role: 'staff', status: 'active' });
  const { data: staffSignIn } = await anon.auth.signInWithPassword({ email: staffEmail, password });
  const staffPost = await fetch(`${API}/api/vendor/stripe/subscription`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${staffSignIn?.session?.access_token ?? 'none'}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider_id: provider.id, plan: 'growth' }),
  });
  check('Staff cannot change the plan', staffPost.status === 403, `HTTP ${staffPost.status}`);
  await admin.auth.admin.deleteUser(staff.user.id);

  // --- 8. An unknown plan is rejected before anything touches Stripe ---
  const bogus = await subscribe('premium');
  check('An unsupported plan is rejected', bogus.r.status === 400, `HTTP ${bogus.r.status}`);
} finally {
  if (customerId) {
    for (const s of await liveSubs(customerId)) await stripe.subscriptions.cancel(s.id, { prorate: false }).catch(() => {});
    await stripe.customers.del(customerId).catch(() => {});
  }
  await admin.from('providers').delete().eq('id', provider.id);
  await admin.auth.admin.deleteUser(owner.user.id);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
