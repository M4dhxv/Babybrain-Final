/**
 * Vendor Stripe Connect (payouts) validation — hits the live routes on a
 * running dev server with a real Bearer token, against Stripe TEST mode.
 *
 *   npm run dev                                   # in another terminal
 *   node scripts/validate-stripe-connect.mjs
 *
 * Creates a throwaway owner + provider and a real test-mode Express account,
 * then cleans both up. Refuses to run against a live Stripe key.
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
} finally {
  if (accountId) await stripe.accounts.del(accountId).catch(() => {});
  await admin.from('providers').delete().eq('id', provider.id);
  await admin.auth.admin.deleteUser(owner.user.id);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
