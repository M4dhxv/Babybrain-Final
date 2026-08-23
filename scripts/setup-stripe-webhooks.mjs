/**
 * Bring the Stripe webhook endpoints in line with what the app handles.
 *
 *   node scripts/setup-stripe-webhooks.mjs            # show what would change
 *   node scripts/setup-stripe-webhooks.mjs --apply    # make the changes
 *
 * Two endpoints are needed, both pointing at /api/webhooks/stripe:
 *
 *   1. an account endpoint  — checkout + subscription events for BabyBrain's
 *      own Stripe account;
 *   2. a Connect endpoint   — `account.*` and `payout.*` for vendors' connected
 *      accounts. These are ONLY delivered to an endpoint created with
 *      `connect: true`, which is why vendor payout status never updated.
 *
 * The Connect endpoint has its own signing secret. On --apply it is appended
 * to .env.local as STRIPE_CONNECT_WEBHOOK_SECRET (never printed); the same
 * value must be set in the deployment env.
 *
 * Acts on whichever mode STRIPE_SECRET_KEY is in. Run once per mode.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import Stripe from 'stripe';

process.loadEnvFile('.env.local');
const apply = process.argv.includes('--apply');
const key = process.env.STRIPE_SECRET_KEY ?? '';
if (!key) {
  console.error('STRIPE_SECRET_KEY is not set.');
  process.exit(1);
}
const mode = key.startsWith('sk_live') ? 'LIVE' : 'TEST';
const stripe = new Stripe(key);

const url =
  process.env.STRIPE_WEBHOOK_URL ??
  `${(process.env.NEXT_PUBLIC_APP_URL ?? 'https://babybrain-final.vercel.app').replace(/\/$/, '')}/api/webhooks/stripe`;

/** Platform-account events — see the switch in app/api/webhooks/stripe/route.ts. */
const ACCOUNT_EVENTS = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.trial_will_end',
  'invoice.payment_failed',
  // Refunds/disputes land on the platform account: destination charges make
  // BabyBrain the merchant of record.
  'charge.refunded',
  'charge.dispute.created',
  'charge.dispute.closed',
];

/** Connected-account events. Require an endpoint with connect: true. */
const CONNECT_EVENTS = [
  'account.updated',
  'account.application.deauthorized',
  'payout.paid',
  'payout.failed',
  'payout.canceled',
  'payout.created',
  'payout.updated',
];

const isConnect = (endpoint) => endpoint.metadata?.connect === 'true';

console.log(`Stripe mode : ${mode}`);
console.log(`Endpoint URL: ${url}`);
console.log(apply ? 'Mode        : APPLY\n' : 'Mode        : dry run (pass --apply to change anything)\n');

const { data: endpoints } = await stripe.webhookEndpoints.list({ limit: 30 });
const mine = endpoints.filter((e) => e.url === url);
const account = mine.find((e) => !isConnect(e));
const connect = mine.find(isConnect);

// --- 1. account endpoint ---
if (!account) {
  console.log('! No account endpoint found at this URL — create one in the Stripe Dashboard first.');
} else {
  const missing = ACCOUNT_EVENTS.filter((e) => !account.enabled_events.includes(e));
  const extra = account.enabled_events.filter(
    (e) => !ACCOUNT_EVENTS.includes(e) && !CONNECT_EVENTS.includes(e)
  );
  if (!missing.length) {
    console.log(`✓ account endpoint ${account.id} already has every event it needs`);
  } else if (apply) {
    // Keep anything already enabled that we don't manage; only ever add.
    const merged = Array.from(new Set([...account.enabled_events, ...ACCOUNT_EVENTS]));
    await stripe.webhookEndpoints.update(account.id, { enabled_events: merged });
    console.log(`✓ account endpoint ${account.id}: added ${missing.join(', ')}`);
  } else {
    console.log(`→ account endpoint ${account.id}: would add ${missing.join(', ')}`);
  }
  if (extra.length) console.log(`  (leaving unmanaged events in place: ${extra.join(', ')})`);
}

// --- 2. Connect endpoint ---
if (connect) {
  const missing = CONNECT_EVENTS.filter((e) => !connect.enabled_events.includes(e));
  if (!missing.length) {
    console.log(`✓ connect endpoint ${connect.id} already has every event it needs`);
  } else if (apply) {
    const merged = Array.from(new Set([...connect.enabled_events, ...CONNECT_EVENTS]));
    await stripe.webhookEndpoints.update(connect.id, { enabled_events: merged });
    console.log(`✓ connect endpoint ${connect.id}: added ${missing.join(', ')}`);
  } else {
    console.log(`→ connect endpoint ${connect.id}: would add ${missing.join(', ')}`);
  }
} else if (apply) {
  const created = await stripe.webhookEndpoints.create({
    url,
    enabled_events: CONNECT_EVENTS,
    connect: true,
    description: 'BabyBrain — Connect events (vendor account status + payouts)',
    metadata: { connect: 'true' },
  });
  console.log(`✓ created connect endpoint ${created.id}`);

  // The signing secret is only readable at creation. Store it rather than
  // printing it, so it doesn't end up in terminal scrollback or logs.
  const envFile = '.env.local';
  const current = readFileSync(envFile, 'utf8');
  if (current.includes('STRIPE_CONNECT_WEBHOOK_SECRET=')) {
    console.log('  ! .env.local already has STRIPE_CONNECT_WEBHOOK_SECRET — not overwriting.');
    console.log('    Replace it by hand with the secret shown in the Stripe Dashboard.');
  } else {
    appendFileSync(envFile, `\nSTRIPE_CONNECT_WEBHOOK_SECRET=${created.secret}\n`);
    console.log(`  → signing secret written to ${envFile} (${created.secret.slice(0, 8)}…)`);
    console.log('    Set the same value in the deployment env before the next deploy.');
  }
} else {
  console.log('→ would create a connect endpoint (connect: true) with:');
  console.log(`  ${CONNECT_EVENTS.join(', ')}`);
}

console.log('\n--- endpoints at this URL ---');
for (const e of (await stripe.webhookEndpoints.list({ limit: 30 })).data.filter((e) => e.url === url)) {
  console.log(`${e.id}  ${e.status}  ${isConnect(e) ? 'CONNECT' : 'account'}  ${e.enabled_events.length} events`);
}
