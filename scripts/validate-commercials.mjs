/**
 * Commercial terms + earnings ledger validation.
 *
 *   npm run dev                              # in another terminal
 *   node scripts/validate-commercials.mjs
 *
 * Checks the split arithmetic, the plan→rate backfill, ledger idempotency,
 * the vendor earnings API and its access gates. Creates and removes its own
 * throwaway vendor. No Stripe calls — the split logic is pure, and the Connect
 * side is covered by validate-stripe-connect.mjs.
 */
import { createClient } from '@supabase/supabase-js';
import postgres from 'postgres';

process.loadEnvFile('.env.local');
const API = process.env.VALIDATE_API_BASE ?? 'http://localhost:3000';
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const sql = postgres(process.env.SUPABASE_DB_URL, { prepare: false });

let pass = 0, fail = 0;
const check = (n, ok, d = '') => { console.log(`${ok ? '✅' : '❌'} ${n}${d ? ` — ${d}` : ''}`); ok ? pass++ : fail++; };

// --- the split arithmetic, mirrored from lib/commercials.ts ---
const estimateFee = (cents) => Math.round(cents * 0.034) + 50;
function computeSplit(amount, terms) {
  const commission = Math.round(amount * terms.rate) + (terms.flat ?? 0);
  const recovery = terms.feePayer === 'vendor' ? estimateFee(amount) : 0;
  const applicationFee = Math.min(commission + recovery, amount);
  const cappedCommission = Math.min(commission, applicationFee);
  return {
    applicationFee,
    commission: cappedCommission,
    recovery: applicationFee - cappedCommission,
    net: amount - applicationFee,
  };
}

const stamp = Date.now();
const email = `terms.owner.${stamp}@babybrain-validation.test`;
const password = 'X12345678!';
const { data: owner } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
const { data: provider } = await admin
  .from('providers')
  .insert({ owner_id: owner.user.id, business_name: `Terms Test Co ${stamp}`, status: 'active', contact_email: email })
  .select()
  .single();
await admin.from('provider_members').insert({ provider_id: provider.id, user_id: owner.user.id, role: 'owner', status: 'active' });

try {
  // --- 1. Split arithmetic ---
  const platform = computeSplit(10000, { rate: 0.15, feePayer: 'platform' });
  check('15%, platform absorbs Stripe → vendor keeps $85',
    platform.applicationFee === 1500 && platform.net === 8500 && platform.recovery === 0,
    JSON.stringify(platform));

  const vendorPays = computeSplit(10000, { rate: 0.15, feePayer: 'vendor' });
  check('15%, vendor absorbs Stripe → fee added on top of commission',
    vendorPays.commission === 1500 && vendorPays.recovery === 390 && vendorPays.net === 8110,
    JSON.stringify(vendorPays));

  const flat = computeSplit(5000, { rate: 0.10, flat: 100, feePayer: 'platform' });
  check('Flat fee stacks on the percentage', flat.applicationFee === 600 && flat.net === 4400, JSON.stringify(flat));

  const tiny = computeSplit(150, { rate: 0.15, flat: 0, feePayer: 'vendor' });
  check('Deductions never exceed the sale (no negative transfer)',
    tiny.applicationFee <= 150 && tiny.net >= 0, JSON.stringify(tiny));

  const free = computeSplit(4000, { rate: 0, flat: 0, feePayer: 'platform' });
  check('Zero-commission deal transfers the whole sale', free.applicationFee === 0 && free.net === 4000);

  // --- 2. Schema + defaults ---
  const [terms] = await sql`
    select commission_rate, commission_flat_cents, fee_payer, commission_on_packages
    from subscriptions where provider_id = ${provider.id}`;
  check('New vendor gets a subscriptions row with terms', Boolean(terms), JSON.stringify(terms));
  if (terms) {
    // 00053 flipped this: vendors absorb Stripe's fee, matching the pricing
    // page. Charges stay destination charges, so liability doesn't move.
    check('Defaults: vendor absorbs Stripe, packs commissionable',
      terms.fee_payer === 'vendor' && terms.commission_on_packages === true,
      `${terms.fee_payer} / packs=${terms.commission_on_packages}`);
  }

  const [{ n: onPlatform }] = await sql`
    select count(*)::int as n from subscriptions where fee_payer <> 'vendor'`;
  check('Every vendor absorbs the Stripe fee (00053)', onPlatform === 0, `${onPlatform} still on platform`);

  const [{ n: stragglers }] = await sql`
    select count(*)::int as n from subscriptions
    where not custom_terms and commission_rate is distinct from plan_commission_rate(plan)`;
  check('Every non-bespoke vendor sits on their plan s advertised rate', stragglers === 0,
    `${stragglers} off-rate`);

  check('A brand-new vendor gets their plan s rate, not the old 15% default',
    Number(terms?.commission_rate) === 0.1, String(terms?.commission_rate));

  // Upgrading a plan should move the rate with it...
  await sql`update subscriptions set plan = 'growth' where provider_id = ${provider.id}`;
  const [upgraded] = await sql`select commission_rate from subscriptions where provider_id = ${provider.id}`;
  check('Upgrading to Growth moves the rate to 15%', Number(upgraded.commission_rate) === 0.15,
    String(upgraded.commission_rate));

  // ...unless a bespoke deal has been struck, which must survive plan changes.
  await sql`update subscriptions set commission_rate = 0.05, custom_terms = true
            where provider_id = ${provider.id}`;
  await sql`update subscriptions set plan = 'pro' where provider_id = ${provider.id}`;
  const [bespoke] = await sql`select commission_rate from subscriptions where provider_id = ${provider.id}`;
  check('A bespoke rate survives a plan change', Number(bespoke.commission_rate) === 0.05,
    String(bespoke.commission_rate));

  // --- 3. Constraints reject nonsense terms ---
  const rejects = async (label, run) => {
    try { await run(); check(label, false, 'was accepted'); }
    catch { check(label, true); }
  };
  await rejects('A 90% commission is rejected',
    () => sql`update subscriptions set commission_rate = 0.9 where provider_id = ${provider.id}`);
  await rejects('A negative flat fee is rejected',
    () => sql`update subscriptions set commission_flat_cents = -100 where provider_id = ${provider.id}`);
  await rejects('An unknown fee payer is rejected',
    () => sql`update subscriptions set fee_payer = 'parent' where provider_id = ${provider.id}`);

  // --- 4. Ledger: idempotency + statuses ---
  const intent = `pi_validate_${stamp}`;
  const row = {
    provider_id: provider.id, source: 'booking', gross_cents: 10000, commission_cents: 1500,
    net_cents: 8500, commission_rate: 0.15, fee_payer: 'platform', routed_to_connect: true,
    stripe_payment_intent: intent, status: 'pending',
  };
  await admin.from('provider_earnings').insert(row);
  const { error: dupe } = await admin.from('provider_earnings').insert(row);
  check('One earning per payment intent (unique index holds)', Boolean(dupe), dupe?.code ?? 'no error');

  await admin.from('provider_earnings').insert({
    ...row, stripe_payment_intent: `${intent}_b`, routed_to_connect: false,
    status: 'platform_owed', gross_cents: 5000, commission_cents: 750, net_cents: 4250,
  });

  // --- 5. Vendor earnings API ---
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  });
  const { data: signIn } = await anon.auth.signInWithPassword({ email, password });
  const headers = { Authorization: `Bearer ${signIn.session.access_token}` };
  const res = await fetch(`${API}/api/vendor/earnings?provider_id=${provider.id}`, { headers });
  const body = await res.json();
  check('Vendor can read their earnings', res.ok, `HTTP ${res.status}`);
  check('Awaiting-payout total counts only Connect-routed money',
    body?.summary?.awaiting_payout_cents === 8500, String(body?.summary?.awaiting_payout_cents));
  check('Money BabyBrain collected is reported separately',
    body?.summary?.owed_by_babybrain_cents === 4250, String(body?.summary?.owed_by_babybrain_cents));
  check('Lifetime totals add up',
    body?.summary?.lifetime_gross_cents === 15000 && body?.summary?.lifetime_commission_cents === 2250,
    `${body?.summary?.lifetime_gross_cents} / ${body?.summary?.lifetime_commission_cents}`);
  check('Ledger rows come back labelled', Array.isArray(body?.ledger) && body.ledger.length === 2
    && body.ledger.every((r) => typeof r.label === 'string'), `${body?.ledger?.length} rows`);

  // --- 6. Access gates ---
  const outsiderEmail = `terms.outsider.${stamp}@babybrain-validation.test`;
  const { data: outsider } = await admin.auth.admin.createUser({ email: outsiderEmail, password, email_confirm: true });
  const { data: outSignIn } = await anon.auth.signInWithPassword({ email: outsiderEmail, password });
  const outRes = await fetch(`${API}/api/vendor/earnings?provider_id=${provider.id}`, {
    headers: { Authorization: `Bearer ${outSignIn.session.access_token}` },
  });
  check('A non-member cannot read another vendor s earnings', outRes.status === 403, `HTTP ${outRes.status}`);

  const anonRes = await fetch(`${API}/api/vendor/earnings?provider_id=${provider.id}`);
  check('Unauthenticated is refused', anonRes.status === 401, `HTTP ${anonRes.status}`);

  // RLS: the outsider's own token must not see the rows directly either.
  const outsiderDb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${outSignIn.session.access_token}` } },
    auth: { persistSession: false },
  });
  const { data: leaked } = await outsiderDb.from('provider_earnings').select('id').eq('provider_id', provider.id);
  check('RLS hides earnings from non-members', (leaked ?? []).length === 0, `${leaked?.length ?? 0} rows visible`);

  const ownerDb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${signIn.session.access_token}` } },
    auth: { persistSession: false },
  });
  const { data: own } = await ownerDb.from('provider_earnings').select('id').eq('provider_id', provider.id);
  check('Members can read their own earnings under RLS', (own ?? []).length === 2, `${own?.length ?? 0} rows`);
  const { error: writeErr } = await ownerDb
    .from('provider_earnings')
    .insert({ ...row, stripe_payment_intent: `${intent}_hack` });
  check('Vendors cannot write their own earnings', Boolean(writeErr), writeErr?.code ?? 'insert succeeded');

  await admin.auth.admin.deleteUser(outsider.user.id);
} finally {
  await admin.from('provider_earnings').delete().eq('provider_id', provider.id);
  await admin.from('providers').delete().eq('id', provider.id);
  await admin.auth.admin.deleteUser(owner.user.id);
  await sql.end();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
