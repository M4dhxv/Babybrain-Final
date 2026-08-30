#!/usr/bin/env node
/**
 * Configure the Stripe Billing Portal the vendor "Manage billing" button opens,
 * and record the configuration id in app_config.
 *
 * QA 23/08: "Can't downgrade anywhere — need an option to downgrade, perhaps on
 * Stripe page when you are clicking reason?" The portal was running on Stripe's
 * default configuration, which has `subscription_update` DISABLED. So the
 * portal offered cancel (with the reason screen the founder saw), card updates
 * and invoices — but no way to move between Growth and Pro. Nothing in the
 * codebase had ever created a configuration, so there was nowhere to turn it on
 * except the Dashboard, by hand, per environment.
 *
 * This creates (or updates) a configuration that allows switching between the
 * Growth and Pro prices in app_config, and pins it by id so test and live
 * behave the same.
 *
 * Usage:
 *   node scripts/setup-stripe-portal.mjs            # show what would change
 *   node scripts/setup-stripe-portal.mjs --apply    # create/update it
 */
import { readFileSync } from 'node:fs';
import Stripe from 'stripe';
import postgres from 'postgres';

for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const APPLY = process.argv.includes('--apply');
const CONFIG_KEY = 'stripe_portal_configuration_id';
const PRICE_KEYS = [
  'stripe_growth_price_id',
  'stripe_growth_price_id_annual',
  'stripe_pro_price_id',
  'stripe_pro_price_id_annual',
];

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const sql = postgres(process.env.SUPABASE_DB_URL, { ssl: 'require' });
const mode = process.env.STRIPE_SECRET_KEY.startsWith('sk_live') ? 'LIVE' : 'TEST';

try {
  const rows = await sql`select key, value from app_config where key in ${sql([...PRICE_KEYS, CONFIG_KEY])}`;
  const cfg = Object.fromEntries(rows.map((r) => [r.key, r.value]));

  const missing = PRICE_KEYS.filter((k) => !cfg[k]);
  if (missing.length) {
    console.error(`Missing price ids in app_config: ${missing.join(', ')}`);
    process.exit(1);
  }

  // Stripe wants products, each with the prices customers may switch to.
  const products = [];
  for (const [plan, keys] of [
    ['growth', ['stripe_growth_price_id', 'stripe_growth_price_id_annual']],
    ['pro', ['stripe_pro_price_id', 'stripe_pro_price_id_annual']],
  ]) {
    const prices = keys.map((k) => cfg[k]);
    const first = await stripe.prices.retrieve(prices[0]);
    products.push({ product: first.product, prices });
    console.log(`${plan.padEnd(7)} product ${first.product}  prices ${prices.join(', ')}`);
  }

  const features = {
    customer_update: { enabled: true, allowed_updates: ['email', 'address', 'name', 'phone', 'tax_id'] },
    invoice_history: { enabled: true },
    payment_method_update: { enabled: true },
    subscription_cancel: {
      enabled: true,
      mode: 'at_period_end',
      cancellation_reason: {
        enabled: true,
        options: ['too_expensive', 'missing_features', 'switched_service', 'unused', 'customer_service', 'other'],
      },
    },
    // The point of the exercise: let a vendor move between Growth and Pro.
    subscription_update: {
      enabled: true,
      default_allowed_updates: ['price'],
      products,
      proration_behavior: 'create_prorations',
    },
  };

  const businessProfile = {
    headline: 'BabyBrain — manage your plan',
    privacy_policy_url: 'https://babybrain.sg/privacy',
    terms_of_service_url: 'https://babybrain.sg/terms',
  };

  if (!APPLY) {
    console.log(`\n[${mode}] dry run — would ${cfg[CONFIG_KEY] ? `update ${cfg[CONFIG_KEY]}` : 'create a new configuration'}`);
    console.log('subscription_update: enabled, price switching, create_prorations');
    console.log('subscription_cancel: enabled, at_period_end, with reason collection');
    console.log('\nRe-run with --apply to write it.');
    process.exit(0);
  }

  let configuration;
  if (cfg[CONFIG_KEY]) {
    configuration = await stripe.billingPortal.configurations.update(cfg[CONFIG_KEY], {
      features,
      business_profile: businessProfile,
    });
    console.log(`\n[${mode}] updated ${configuration.id}`);
  } else {
    configuration = await stripe.billingPortal.configurations.create({
      features,
      business_profile: businessProfile,
    });
    await sql`
      insert into app_config (key, value) values (${CONFIG_KEY}, ${configuration.id})
      on conflict (key) do update set value = excluded.value`;
    console.log(`\n[${mode}] created ${configuration.id} and stored it in app_config.${CONFIG_KEY}`);
  }
  console.log('subscription_update enabled:', configuration.features.subscription_update.enabled);
  // Stripe validates `products` on write (a bad product id is rejected) but
  // does not echo the list back on read, so there is nothing to assert here
  // beyond the call having succeeded.
} finally {
  await sql.end();
}
