#!/usr/bin/env node
/**
 * Provision everything Stripe-side that a mode needs, and record the ids in
 * `app_config` under mode-scoped keys.
 *
 *   node scripts/bootstrap-stripe-mode.mjs            # report what's missing
 *   node scripts/bootstrap-stripe-mode.mjs --apply    # create it
 *
 * Test and live share no objects: every `price_`, `bpc_`, `cus_`, `sub_` and
 * `acct_` in the database belongs to exactly one mode. Going live is therefore
 * not a key swap — the whole catalog has to exist again on the live side, and
 * `app_config` has to be able to hold both at once because ONE database is
 * shared by production, previews and local dev (see lib/stripe-config.ts).
 *
 * So this writes `live_stripe_plus_price_id` / `test_stripe_plus_price_id`
 * rather than the bare key, which lib/stripe-config.ts prefers over the bare
 * one for the mode it is running in. Existing bare rows are left alone.
 *
 * Idempotent: products and prices are matched on what is already in the
 * account (by product name, then by exact unit_amount + interval + currency)
 * and only created when genuinely absent. Safe to re-run.
 *
 * What this does NOT do, because it cannot:
 *   - activate the live Stripe account (business details, bank, ToS)
 *   - set env vars in the deployment
 *   - onboard vendors onto Connect — each one does that themselves
 * `docs/go-live-stripe.md` is the checklist for those.
 */
import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

process.loadEnvFile('.env.local');

const APPLY = process.argv.includes('--apply');
const KEY = process.env.STRIPE_SECRET_KEY ?? '';
if (!KEY) {
  console.error('STRIPE_SECRET_KEY is not set.');
  process.exit(1);
}
const MODE = KEY.startsWith('sk_live') ? 'live' : 'test';
const stripe = new Stripe(KEY);
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

/**
 * The catalog, as the Plans pages advertise it. Annual is "11 months for the
 * price of 12" — the ratio the existing test-mode prices already use, and the
 * numbers the vendor and parent Plans copy has hardcoded.
 */
const CURRENCY = 'sgd';
const CATALOG = [
  { plan: 'plus', product: 'Plus', monthly: 900, annual: 9900 },
  { plan: 'growth', product: 'Growth', monthly: 9900, annual: 108900 },
  { plan: 'pro', product: 'Pro', monthly: 19900, annual: 218900 },
];

const money = (c) => `${(c / 100).toFixed(2)} ${CURRENCY.toUpperCase()}`;
const planned = [];
const note = (what) => {
  planned.push(what);
  console.log(`  ${APPLY ? '→' : 'would'} ${what}`);
};

console.log(`Stripe mode: ${MODE.toUpperCase()}${APPLY ? '' : '  (dry run)'}\n`);

// A live key on an unactivated account can create prices but never charge, so
// say so up front rather than letting it look finished.
const account = await stripe.accounts.retrieve();
console.log(`account ${account.id} — charges_enabled=${account.charges_enabled} payouts_enabled=${account.payouts_enabled}`);
if (MODE === 'live' && !account.charges_enabled) {
  console.log('  ⚠ live charges are NOT enabled on this account yet — finish activation in the Stripe Dashboard.');
}
console.log();

const allProducts = await stripe.products.list({ limit: 100, active: true });
const configWrites = {};

for (const entry of CATALOG) {
  console.log(`${entry.product}:`);
  let product = allProducts.data.find((p) => p.name.toLowerCase() === entry.product.toLowerCase());
  if (!product) {
    if (APPLY) {
      product = await stripe.products.create({ name: entry.product });
      console.log(`  → created product ${product.id}`);
    } else {
      note(`create product "${entry.product}"`);
    }
  } else {
    console.log(`  product ${product.id} (existing)`);
  }

  const existing = product
    ? (await stripe.prices.list({ product: product.id, limit: 100, active: true })).data
    : [];

  for (const [interval, amount, keySuffix] of [
    ['month', entry.monthly, ''],
    ['year', entry.annual, '_annual'],
  ]) {
    const logicalKey = `stripe_${entry.plan}_price_id${keySuffix}`;
    const match = existing.find(
      (p) =>
        p.unit_amount === amount && p.currency === CURRENCY && p.recurring?.interval === interval
    );

    if (match) {
      console.log(`  ${interval.padEnd(5)} ${money(amount)} → ${match.id} (existing)`);
      configWrites[logicalKey] = match.id;
    } else if (APPLY && product) {
      const price = await stripe.prices.create({
        product: product.id,
        currency: CURRENCY,
        unit_amount: amount,
        recurring: { interval },
      });
      console.log(`  ${interval.padEnd(5)} ${money(amount)} → created ${price.id}`);
      configWrites[logicalKey] = price.id;
    } else {
      note(`create ${interval}ly price ${money(amount)} for ${entry.product}`);
    }
  }
  console.log();
}

// Not a Stripe id, so it is not mode-scoped — but it must exist or Boost
// silently falls back to a hardcoded default.
const { data: boost } = await admin
  .from('app_config')
  .select('value')
  .eq('key', 'stripe_boost_amount_cents')
  .maybeSingle();
if (!boost) {
  if (APPLY) {
    await admin.from('app_config').upsert({ key: 'stripe_boost_amount_cents', value: '3000' });
    console.log('→ set stripe_boost_amount_cents = 3000 (SGD 30 / 14 days)');
  } else {
    note('set stripe_boost_amount_cents = 3000');
  }
}

if (APPLY && Object.keys(configWrites).length) {
  const rows = Object.entries(configWrites).map(([key, value]) => ({ key: `${MODE}_${key}`, value }));
  const { error } = await admin.from('app_config').upsert(rows, { onConflict: 'key' });
  if (error) {
    console.error(`\nFailed to write app_config: ${error.message}`);
    process.exit(1);
  }
  console.log(`\nWrote ${rows.length} mode-scoped app_config rows:`);
  for (const r of rows) console.log(`  ${r.key} = ${r.value}`);
} else if (!APPLY) {
  console.log('app_config rows that would be written:');
  for (const [k, v] of Object.entries(configWrites)) console.log(`  ${MODE}_${k} = ${v}`);
}

console.log(`\nNext, for this mode:`);
console.log('  node scripts/setup-stripe-portal.mjs --apply     # both billing portal configurations');
console.log('  node scripts/setup-stripe-webhooks.mjs --apply   # both webhook endpoints + signing secrets');
console.log('  node scripts/validate-stripe-config.mjs          # confirm every stored id resolves');
if (!APPLY && planned.length) {
  console.log(`\n${planned.length} thing(s) to create. Re-run with --apply.`);
}
