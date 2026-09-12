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
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
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
  // Frees the pending event-ticket order when a checkout is abandoned.
  'checkout.session.expired',
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

/**
 * A signing secret is readable ONCE, at creation. Append it to a gitignored
 * file rather than printing it, so it survives terminal scrollback but does
 * not leak into logs or a screen share.
 *
 * This used to write into .env.local, which broke the moment that file already
 * held a secret for the other mode: it printed "not overwriting" and the live
 * secret was lost for good (recoverable only from the Dashboard). A per-mode
 * file sidesteps that entirely.
 */
const SECRETS_FILE = '.stripe-webhook-secrets.local.md';
function stashSecret(label, endpoint) {
  if (!existsSync(SECRETS_FILE)) {
    appendFileSync(SECRETS_FILE, '# Stripe webhook signing secrets\n\nGitignored. Set these in the deployment env.\n');
  }
  appendFileSync(
    SECRETS_FILE,
    `\n## ${mode} — ${label}\n- endpoint: ${endpoint.id}\n- env var: ${label === 'connect' ? 'STRIPE_CONNECT_WEBHOOK_SECRET' : 'STRIPE_WEBHOOK_SECRET'}\n- secret: ${endpoint.secret}\n`
  );
  console.log(`  → signing secret written to ${SECRETS_FILE} (${endpoint.secret.slice(0, 8)}…)`);
}

console.log(`Stripe mode : ${mode}`);
console.log(`Endpoint URL: ${url}`);
console.log(apply ? 'Mode        : APPLY\n' : 'Mode        : dry run (pass --apply to change anything)\n');

const { data: endpoints } = await stripe.webhookEndpoints.list({ limit: 30 });
const mine = endpoints.filter((e) => e.url === url);
const account = mine.find((e) => !isConnect(e));
const connect = mine.find(isConnect);

// --- 1. account endpoint ---
if (!account && apply) {
  // Previously this only ever told you to go and make one by hand, which is
  // fine for the sandbox (where one predated this script) but meant a fresh
  // account — i.e. every go-live — ended up with ONLY the Connect endpoint and
  // no way to confirm a payment.
  const created = await stripe.webhookEndpoints.create({
    url,
    enabled_events: ACCOUNT_EVENTS,
    description: 'BabyBrain — account events (checkout + subscriptions)',
    metadata: { connect: 'false' },
  });
  console.log(`✓ created account endpoint ${created.id} with ${ACCOUNT_EVENTS.length} events`);
  stashSecret('account', created);
} else if (!account) {
  console.log(`→ would create an account endpoint with ${ACCOUNT_EVENTS.length} events`);
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

  stashSecret('connect', created);
} else {
  console.log('→ would create a connect endpoint (connect: true) with:');
  console.log(`  ${CONNECT_EVENTS.join(', ')}`);
}

console.log('\n--- endpoints at this URL ---');
for (const e of (await stripe.webhookEndpoints.list({ limit: 30 })).data.filter((e) => e.url === url)) {
  console.log(`${e.id}  ${e.status}  ${isConnect(e) ? 'CONNECT' : 'account'}  ${e.enabled_events.length} events`);
}
