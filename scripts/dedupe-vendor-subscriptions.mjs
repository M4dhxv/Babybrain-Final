#!/usr/bin/env node
/**
 * Find — and optionally clean up — vendors carrying more than one live Stripe
 * subscription, and realign `subscriptions.plan` with what Stripe is billing.
 *
 * QA 23/08: "If you are already on the Pro plan, you shouldn't be able to get
 * to stripe payment to upgrade to the plan you are already on." The checkout
 * route never looked at the current plan and Stripe does not deduplicate, so
 * every click on a plan button minted another subscription against the same
 * customer. The route no longer does that, but subscriptions already stacked
 * up have to be unwound by hand — silently cancelling someone's subscription
 * is not something a page load should do, hence a script you run deliberately.
 *
 * The keeper is the OLDEST live subscription (it holds the real trial /
 * billing anchor). Duplicates are cancelled immediately, since a duplicate
 * never entitled the vendor to anything the keeper doesn't already give them.
 *
 * Usage:
 *   node scripts/dedupe-vendor-subscriptions.mjs           # report only
 *   node scripts/dedupe-vendor-subscriptions.mjs --apply   # cancel duplicates
 */
import { readFileSync } from 'node:fs';
import Stripe from 'stripe';
import postgres from 'postgres';

for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const APPLY = process.argv.includes('--apply');
const LIVE = ['active', 'trialing', 'past_due', 'unpaid'];

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const sql = postgres(process.env.SUPABASE_DB_URL, { ssl: 'require' });
const mode = process.env.STRIPE_SECRET_KEY.startsWith('sk_live') ? 'LIVE' : 'TEST';

const money = (p) => `${(p.unit_amount / 100).toFixed(0)} ${p.currency.toUpperCase()}/${p.recurring?.interval ?? 'once'}`;

try {
  const priceRows = await sql`
    select key, value from app_config
    where key in ('stripe_growth_price_id','stripe_growth_price_id_annual',
                  'stripe_pro_price_id','stripe_pro_price_id_annual')`;
  const planOfPrice = new Map(
    priceRows.map((r) => [r.value, r.key.startsWith('stripe_pro_') ? 'pro' : 'growth'])
  );

  const vendors = await sql`
    select s.provider_id, p.business_name, s.plan, s.stripe_customer_id
    from subscriptions s join providers p on p.id = s.provider_id
    where s.stripe_customer_id is not null`;

  console.log(`[${mode}] checking ${vendors.length} vendor customer(s)\n`);

  let stacked = 0;
  let drifted = 0;
  let cancelled = 0;

  for (const v of vendors) {
    const all = await stripe.subscriptions.list({
      customer: v.stripe_customer_id,
      status: 'all',
      limit: 100,
    });
    // Only this provider's own subscriptions — never touch anything else
    // sharing the customer.
    const live = all.data
      .filter((s) => LIVE.includes(s.status))
      .filter((s) => !s.metadata?.user_id)
      .sort((a, b) => a.created - b.created);

    if (live.length === 0) continue;

    const keeper = live[0];
    const dupes = live.slice(1);
    const truePlan = planOfPrice.get(keeper.items.data[0]?.price?.id) ?? keeper.metadata?.plan ?? 'growth';

    if (dupes.length) {
      stacked++;
      console.log(`${v.business_name} (${v.stripe_customer_id})`);
      console.log(`  keep     ${keeper.id}  ${keeper.status}  ${money(keeper.items.data[0].price)}  created ${new Date(keeper.created * 1000).toISOString().slice(0, 10)}`);
      for (const d of dupes) {
        console.log(`  cancel   ${d.id}  ${d.status}  ${money(d.items.data[0].price)}  created ${new Date(d.created * 1000).toISOString().slice(0, 10)}`);
      }
      if (APPLY) {
        for (const d of dupes) {
          await stripe.subscriptions.cancel(d.id, { prorate: false });
          cancelled++;
        }
        console.log(`  → cancelled ${dupes.length} duplicate(s)`);
      }
    }

    if (v.plan !== truePlan) {
      drifted++;
      console.log(`${v.business_name}: db plan '${v.plan}' but Stripe is billing '${truePlan}'`);
      if (APPLY) {
        await sql`
          update subscriptions
          set plan = ${truePlan},
              stripe_subscription_id = ${keeper.id},
              status = ${keeper.status === 'unpaid' ? 'past_due' : keeper.status}
          where provider_id = ${v.provider_id}`;
        console.log(`  → set to '${truePlan}', pinned to ${keeper.id}`);
      }
    }
  }

  console.log(`\n${stacked} vendor(s) with stacked subscriptions, ${drifted} with a plan mismatch.`);
  if (!APPLY && (stacked || drifted)) {
    console.log('Report only. Re-run with --apply to cancel the duplicates and fix the plans.');
  }
  if (APPLY) console.log(`Cancelled ${cancelled} duplicate subscription(s).`);
} finally {
  await sql.end();
}
