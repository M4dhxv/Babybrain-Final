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
 * It also creates a SECOND configuration for parents. The vendor one lists
 * only the Growth and Pro products, so it cannot be reused for a parent on
 * Plus — Stripe would enable plan switching with nothing switchable in it.
 * Without one of its own the parent portal fell back to Stripe's default
 * configuration, where `subscription_update` is disabled, so a Plus parent
 * could cancel but never move between monthly and annual.
 *
 * Usage:
 *   node scripts/setup-stripe-portal.mjs            # show what would change
 *   node scripts/setup-stripe-portal.mjs --apply    # create/update it
 */
import { readFileSync } from 'node:fs';
import Stripe from 'stripe';
import postgres from 'postgres';
import { parseDbUrl } from './lib/db-url.mjs';

for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const APPLY = process.argv.includes('--apply');
const CONFIG_KEY = 'stripe_portal_configuration_id';
const PARENT_CONFIG_KEY = 'stripe_parent_portal_configuration_id';
const PRICE_KEYS = [
  'stripe_growth_price_id',
  'stripe_growth_price_id_annual',
  'stripe_pro_price_id',
  'stripe_pro_price_id_annual',
  'stripe_plus_price_id',
  'stripe_plus_price_id_annual',
];

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const sql = postgres({ ...parseDbUrl(process.env.SUPABASE_DB_URL), ...{ ssl: 'require' } });
const mode = process.env.STRIPE_SECRET_KEY.startsWith('sk_live') ? 'LIVE' : 'TEST';

try {
  const rows = await sql`select key, value from app_config where key in ${sql([...PRICE_KEYS, CONFIG_KEY, PARENT_CONFIG_KEY])}`;
  const cfg = Object.fromEntries(rows.map((r) => [r.key, r.value]));

  const missing = PRICE_KEYS.filter((k) => !cfg[k]);
  if (missing.length) {
    console.error(`Missing price ids in app_config: ${missing.join(', ')}`);
    process.exit(1);
  }

  // Stripe wants products, each with the prices customers may switch to.
  const productsFor = async (plans) => {
    const out = [];
    for (const [plan, keys] of plans) {
      const prices = keys.map((k) => cfg[k]);
      const first = await stripe.prices.retrieve(prices[0]);
      out.push({ product: first.product, prices });
      console.log(`${plan.padEnd(7)} product ${first.product}  prices ${prices.join(', ')}`);
    }
    return out;
  };

  const products = await productsFor([
    ['growth', ['stripe_growth_price_id', 'stripe_growth_price_id_annual']],
    ['pro', ['stripe_pro_price_id', 'stripe_pro_price_id_annual']],
  ]);
  const parentProducts = await productsFor([
    ['plus', ['stripe_plus_price_id', 'stripe_plus_price_id_annual']],
  ]);

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

  // Public origin the portal footer's Terms / Privacy links point back to.
  // `babybrain.sg` is not live yet (production is the Vercel host, see
  // docs/SETUP.md), so both links 404'd. `/privacy` is also not a route —
  // the privacy notice is a section on the Terms page (`/terms#privacy`),
  // which is where the rest of the app links it. Set NEXT_PUBLIC_APP_URL to
  // override after the babybrain.sg cutover.
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || 'https://babybrain-final.vercel.app').replace(/\/+$/, '');
  const businessProfile = {
    headline: 'BabyBrain — manage your plan',
    // A bare path, not a `#privacy` fragment: Stripe renders these as plain
    // links and a fragment is easy for an intermediary to drop. /privacy is a
    // real route in the parent SPA and opens the Terms at that section.
    privacy_policy_url: `${appUrl}/privacy`,
    terms_of_service_url: `${appUrl}/terms`,
  };

  if (!APPLY) {
    console.log(`\n[${mode}] dry run — vendor: would ${cfg[CONFIG_KEY] ? `update ${cfg[CONFIG_KEY]}` : 'create a new configuration'}`);
    console.log(`[${mode}] dry run — parent: would ${cfg[PARENT_CONFIG_KEY] ? `update ${cfg[PARENT_CONFIG_KEY]}` : 'create a new configuration'}`);
    console.log('subscription_update: enabled, price switching, create_prorations');
    console.log('subscription_cancel: enabled, at_period_end, with reason collection');
    console.log('\nRe-run with --apply to write it.');
    process.exit(0);
  }

  /** Create or update one configuration and pin its id in app_config. */
  const upsertConfiguration = async (label, key, feats) => {
    let configuration;
    if (cfg[key]) {
      configuration = await stripe.billingPortal.configurations.update(cfg[key], {
        features: feats,
        business_profile: businessProfile,
      });
      console.log(`\n[${mode}] ${label}: updated ${configuration.id}`);
    } else {
      configuration = await stripe.billingPortal.configurations.create({
        features: feats,
        business_profile: businessProfile,
      });
      await sql`
        insert into app_config (key, value) values (${key}, ${configuration.id})
        on conflict (key) do update set value = excluded.value`;
      console.log(`\n[${mode}] ${label}: created ${configuration.id} and stored it in app_config.${key}`);
    }
    console.log(`${label}: subscription_update enabled:`, configuration.features.subscription_update.enabled);
    // Stripe validates `products` on write (a bad product id is rejected) but
    // does not echo the list back on read, so there is nothing to assert here
    // beyond the call having succeeded.
    return configuration;
  };

  await upsertConfiguration('vendor', CONFIG_KEY, features);
  await upsertConfiguration('parent', PARENT_CONFIG_KEY, {
    ...features,
    subscription_update: { ...features.subscription_update, products: parentProducts },
  });
} finally {
  await sql.end();
}
