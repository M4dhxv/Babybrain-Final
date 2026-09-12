#!/usr/bin/env node
/**
 * Find — and optionally clean up — parents carrying more than one live Stripe
 * subscription, and realign `customer_subscriptions` with what Stripe is
 * actually billing.
 *
 * The parent sibling of dedupe-vendor-subscriptions.mjs. The vendor checkout
 * route was fixed in Aug 2026 to refuse a plan it already had; the parent Plus
 * route was not, and guarded only on `customer_subscriptions.plan` — which the
 * webhook writes, so every click before that landed minted another
 * subscription against the same customer. One test parent had four live at
 * once, three of them on inline prices predating the Product catalog. The
 * route now asks Stripe, but subscriptions already stacked up have to be
 * unwound deliberately rather than by a page load.
 *
 * The keeper is the OLDEST live subscription (it holds the real trial /
 * billing anchor). Duplicates are cancelled immediately: a duplicate never
 * entitled the parent to anything the keeper doesn't already give them.
 *
 * Usage:
 *   node scripts/dedupe-parent-subscriptions.mjs           # report only
 *   node scripts/dedupe-parent-subscriptions.mjs --apply   # cancel duplicates
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
const LIVE = ['active', 'trialing', 'past_due', 'unpaid'];

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const sql = postgres({ ...parseDbUrl(process.env.SUPABASE_DB_URL), ...{ ssl: 'require' } });
const mode = process.env.STRIPE_SECRET_KEY.startsWith('sk_live') ? 'LIVE' : 'TEST';

const money = (p) => `${(p.unit_amount / 100).toFixed(0)} ${p.currency.toUpperCase()}/${p.recurring?.interval ?? 'once'}`;
const intervalOf = (s) => {
  const i = s.items.data[0]?.price?.recurring?.interval;
  return i === 'month' ? 'monthly' : i === 'year' ? 'annual' : null;
};
// Same collapse the app applies (lib/plans.ts dbStatus): the column's CHECK
// constraint predates several statuses Stripe actually sends.
const dbStatus = (s) => (s === 'unpaid' ? 'past_due' : s === 'paused' || s === 'incomplete_expired' ? 'canceled' : s);

try {
  const parents = await sql`
    select user_id, plan, billing_interval, status, stripe_customer_id
    from customer_subscriptions
    where stripe_customer_id is not null`;

  console.log(`[${mode}] checking ${parents.length} parent customer(s)\n`);

  let stacked = 0;
  let drifted = 0;
  let cancelled = 0;

  for (const p of parents) {
    const all = await stripe.subscriptions.list({
      customer: p.stripe_customer_id,
      status: 'all',
      limit: 100,
    });
    // Only this parent's own subscriptions — never touch a vendor one that
    // somehow shares the customer (the inverse of the vendor script's filter).
    const live = all.data
      .filter((s) => LIVE.includes(s.status))
      .filter((s) => !s.metadata?.provider_id)
      .sort((a, b) => a.created - b.created);

    const keeper = live[0] ?? null;
    const dupes = live.slice(1);
    const truePlan = keeper ? 'plus' : 'free';

    if (dupes.length) {
      stacked++;
      console.log(`parent ${p.user_id} (${p.stripe_customer_id})`);
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

    const trueInterval = keeper ? intervalOf(keeper) : null;
    const trueStatus = keeper ? dbStatus(keeper.status) : 'canceled';
    const mismatch =
      p.plan !== truePlan ||
      (trueInterval && p.billing_interval !== trueInterval) ||
      (keeper && p.status !== trueStatus);

    if (mismatch) {
      drifted++;
      console.log(
        `parent ${p.user_id}: db ${p.plan}/${p.billing_interval ?? '-'}/${p.status ?? '-'} but Stripe is billing ${truePlan}/${trueInterval ?? '-'}/${trueStatus}`
      );
      if (APPLY) {
        await sql`
          update customer_subscriptions
          set plan = ${truePlan},
              billing_interval = coalesce(${trueInterval}, billing_interval),
              stripe_subscription_id = ${keeper?.id ?? null},
              status = ${trueStatus},
              cancel_at_period_end = ${keeper?.cancel_at_period_end ?? false}
          where user_id = ${p.user_id}`;
        console.log(`  → set to ${truePlan}/${trueInterval ?? 'unchanged'}, pinned to ${keeper?.id ?? 'none'}`);
      }
    }
  }

  console.log(`\n${stacked} parent(s) with stacked subscriptions, ${drifted} with a plan mismatch.`);
  if (!APPLY && (stacked || drifted)) {
    console.log('Report only. Re-run with --apply to cancel the duplicates and fix the plans.');
  }
  if (APPLY) console.log(`Cancelled ${cancelled} duplicate subscription(s).`);
} finally {
  await sql.end();
}
