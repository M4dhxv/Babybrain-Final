/**
 * Check that every Stripe id the app has stored still resolves — in whichever
 * mode STRIPE_SECRET_KEY is in.
 *
 *   node scripts/validate-stripe-config.mjs
 *
 * Stripe's test and live modes share no objects. A price, portal
 * configuration, customer, subscription or connected account created in test
 * simply does not exist in live, so the instant the key changes every id the
 * database is holding goes dangling.
 *
 * The `app_config` price ids are the ones that bite hardest: they are read on
 * every subscription checkout, so a stale one breaks signup for EVERY new
 * subscriber rather than only the users who already had a row. Run this
 * against a live key BEFORE pointing production at it.
 *
 * Read-only against both Stripe and the database.
 */
import postgres from 'postgres';
import Stripe from 'stripe';
import { parseDbUrl } from './lib/db-url.mjs';

process.loadEnvFile('.env.local');

const key = process.env.STRIPE_SECRET_KEY ?? '';
if (!key) {
  console.error('STRIPE_SECRET_KEY is not set.');
  process.exit(1);
}
const mode = key.startsWith('sk_live') ? 'LIVE' : 'TEST';
const stripe = new Stripe(key);
const sql = postgres({ ...parseDbUrl(process.env.SUPABASE_DB_URL), prepare: false, ssl: 'require' });

let pass = 0, fail = 0;
const check = (n, ok, d = '') => { console.log(`${ok ? '✅' : '❌'} ${n}${d ? ` — ${d}` : ''}`); ok ? pass++ : fail++; };

/** Resolve one id, choosing the endpoint from its prefix. */
async function resolve(id) {
  try {
    if (id.startsWith('price_')) await stripe.prices.retrieve(id);
    else if (id.startsWith('prod_')) await stripe.products.retrieve(id);
    else if (id.startsWith('bpc_')) await stripe.billingPortal.configurations.retrieve(id);
    else if (id.startsWith('acct_')) await stripe.accounts.retrieve(id);
    else if (id.startsWith('sub_')) await stripe.subscriptions.retrieve(id);
    else if (id.startsWith('cus_')) await stripe.customers.retrieve(id);
    else return { ok: true, note: 'not an id — skipped' };
    return { ok: true };
  } catch (e) {
    // resource_missing is the interesting failure: the id is well-formed but
    // belongs to the other mode (or was deleted). Anything else — auth, network
    // — is a problem with the run, not with the stored id, so say which.
    return { ok: false, note: e.code === 'resource_missing' ? `missing in ${mode} mode` : e.message };
  }
}

async function checkAll(label, rows) {
  if (!rows.length) { check(label, true, 'nothing stored'); return; }
  const bad = [];
  for (const r of rows) {
    const { ok, note } = await resolve(r.id);
    if (!ok) bad.push(`${r.label} (${r.id.slice(0, 18)}…): ${note}`);
  }
  check(label, bad.length === 0, bad.length ? bad.join('; ') : `${rows.length} resolve in ${mode}`);
}

console.log(`Stripe mode: ${mode}\n`);
try {
  // 1. app_config — read on every checkout, so a stale id breaks all new signups.
  //
  // Rows are mode-scoped (`live_…` / `test_…`, see lib/stripe-config.ts), and
  // the OTHER mode's ids are supposed to be unresolvable here — checking them
  // would report a correct setup as broken. Bare legacy keys belong to
  // whichever mode was current when they were written, so they are checked.
  const other = mode === 'LIVE' ? 'test_' : 'live_';
  const cfgAll = await sql`select key, value from public.app_config
    where value ~ '^(price|prod|bpc)_' order by key`;
  const cfg = cfgAll.filter((r) => !r.key.startsWith(other));
  await checkAll('app_config Stripe ids resolve',
    cfg.map((r) => ({ id: r.value, label: r.key })));
  if (cfgAll.length !== cfg.length) {
    console.log(`   (skipped ${cfgAll.length - cfg.length} row(s) belonging to the other mode)`);
  }

  /* 1b. The preflight that actually matters before pointing production at a
     key: can a checkout resolve a price AT ALL in this mode? A missing row
     here 500s every new subscription, not just the users who already have
     one. Mirrors stripeConfig() — mode-scoped key first, bare key second. */
  const scope = mode.toLowerCase() + '_';
  const byKey = new Map(cfgAll.map((r) => [r.key, r.value]));
  const REQUIRED = [
    'stripe_plus_price_id', 'stripe_plus_price_id_annual',
    'stripe_growth_price_id', 'stripe_growth_price_id_annual',
    'stripe_pro_price_id', 'stripe_pro_price_id_annual',
  ];
  const unresolved = REQUIRED.filter((k) => !(byKey.get(scope + k) ?? byKey.get(k)));
  check(`Every plan price resolves in ${mode} mode`, unresolved.length === 0,
    unresolved.length ? `missing: ${unresolved.join(', ')} — run stripe:bootstrap` : `${REQUIRED.length} plan prices`);

  const portals = ['stripe_portal_configuration_id', 'stripe_parent_portal_configuration_id'];
  const noPortal = portals.filter((k) => !(byKey.get(scope + k) ?? byKey.get(k)));
  check(`Both billing portal configurations are pinned in ${mode} mode`, noPortal.length === 0,
    noPortal.length ? `missing: ${noPortal.join(', ')} — run stripe:portal --apply` : 'vendor + parent');

  // 2. connected accounts — a vendor whose account is missing cannot be paid.
  const accts = await sql`select business_name b, stripe_account_id a from public.providers
    where stripe_account_id is not null`;
  await checkAll('Connected accounts resolve',
    accts.map((r) => ({ id: r.a, label: r.b ?? 'provider' })));

  // 3. stored subscriptions — these break the billing portal and plan gating.
  const vend = await sql`select stripe_subscription_id s from public.subscriptions
    where stripe_subscription_id is not null`;
  const cust = await sql`select stripe_subscription_id s from public.customer_subscriptions
    where stripe_subscription_id is not null`;
  await checkAll('Vendor subscriptions resolve', vend.map((r) => ({ id: r.s, label: 'vendor sub' })));
  await checkAll('Parent subscriptions resolve', cust.map((r) => ({ id: r.s, label: 'parent sub' })));
} finally {
  await sql.end();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
