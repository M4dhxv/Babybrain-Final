# Going live on Stripe

Everything Stripe-related has only ever run in **test mode**. This is what the
switch actually involves.

The important thing to understand first: **test and live share no objects.**
Every `price_`, `prod_`, `bpc_`, `cus_`, `sub_` and `acct_` stored in the
database exists in exactly one mode. Swapping the secret key does not migrate
them — it makes all of them dangling. So going live is provisioning a second
catalog, not flipping a switch.

---

## 1. Things only a human can do

These block everything else and none of them can be scripted.

- [ ] **Activate the live Stripe account.** Business details, representative,
      bank account, accept Stripe's terms. Until this is done the live account
      reports `charges_enabled: false` with every capability `inactive`, and no
      charge will succeed. (The test sandbox reports the same thing, which is
      normal for a sandbox and is why it is not a useful signal there.)
- [ ] **Get the live secret key** (`sk_live_…`) from the Dashboard.
- [ ] **Decide on GST.** Stripe Tax is still not enabled. Prices are currently
      advertised and charged GST-exclusive. This is a pricing/legal decision,
      not a code change, and it is easier to settle before the first live
      invoice than after.

## 2. Provision the live catalog

With the live key in `.env.local` (or exported), each of these is dry-run by
default and idempotent — run without `--apply` first and read the plan.

```bash
node scripts/bootstrap-stripe-mode.mjs --apply     # products, prices, app_config
node scripts/setup-stripe-portal.mjs --apply       # both billing portal configurations
node scripts/setup-stripe-webhooks.mjs --apply     # both webhook endpoints + signing secrets
```

What they write:

| Script | Creates |
|---|---|
| `bootstrap-stripe-mode` | Plus / Growth / Pro products, monthly + annual prices (SGD 9·99, 99·1089, 199·2189), and `live_stripe_*_price_id` rows |
| `setup-stripe-portal` | Vendor configuration (Growth ⇄ Pro) and parent configuration (Plus monthly ⇄ annual). Both are needed — the vendor one lists only Growth and Pro, so it cannot serve a Plus parent |
| `setup-stripe-webhooks` | The account endpoint (12 events) and the Connect endpoint (7 events). Connect events are **only** delivered to an endpoint created with `connect: true` |

### Why the config keys are mode-scoped

`app_config` is `key text primary key`, and **one hosted database serves
production, previews and every developer's machine.** A single
`stripe_plus_price_id` row therefore cannot hold both a live and a test price:
put a live id in it and every local checkout running the test key hands Stripe
a live price and 500s.

So these scripts write `live_stripe_plus_price_id` / `test_stripe_plus_price_id`,
and `lib/stripe-config.ts` resolves mode-first with a fallback to the bare key.
The bare rows that exist today keep working, so this is safe to deploy before
anything live exists.

## 3. Deployment environment

Set in Vercel production (not just `.env.local`):

- [ ] `STRIPE_SECRET_KEY` = the live key
- [ ] `STRIPE_WEBHOOK_SECRET` = account endpoint signing secret
- [ ] `STRIPE_CONNECT_WEBHOOK_SECRET` = Connect endpoint signing secret
- [ ] `NEXT_PUBLIC_APP_URL` = the live origin

Both signing secrets matter. The webhook route verifies each delivery against
either one, so a missing Connect secret silently drops every `account.updated`
and `payout.*` event — which is how vendor payout status went stale for months.

## 4. Preflight — run this BEFORE pointing production at the key

```bash
node scripts/validate-stripe-config.mjs
```

Read-only. It resolves every stored id against the current mode, skips rows
belonging to the other mode, and fails loudly if any plan price or portal
configuration is unresolvable. A missing price row breaks **every new
subscriber**, not just users who already have a row, so this is the one check
worth treating as a gate.

## 5. What does not carry over

Expect these, and don't treat them as bugs:

- **Existing subscriptions are test objects.** Every `cus_`/`sub_` in
  `subscriptions` and `customer_subscriptions` becomes unresolvable. The portal
  routes already turn that into "That billing account is no longer available.
  Please contact support." rather than a 500, but anyone currently on a plan is
  not actually subscribed in live.
- **Every vendor must re-onboard Connect.** `providers.stripe_account_id` holds
  test `acct_` ids. There is no migration: Express onboarding is a per-vendor
  action each one completes themselves via the "Connect payouts" button, and it
  ends in a photo-ID and selfie check that cannot be automated or completed on
  their behalf. **As of 2026-09-12 no genuine vendor has completed it in any
  mode** — the one fully-onboarded account is a QA provider on the
  `@babybrain.sg` domain with a `STRIPE TEST BANK` account.
- **Paid bookings still work without Connect.** The booking checkout only adds
  `application_fee_amount` + `transfer_data.destination` when the provider has
  `payouts_enabled`; otherwise the charge stays on the platform account and the
  earnings ledger records what BabyBrain owes them, to be settled manually. So
  launching before vendors onboard is viable, just operationally heavier.

## 6. After the switch

```bash
node scripts/validate-stripe-config.mjs        # all ids resolve in live
node scripts/dedupe-vendor-subscriptions.mjs   # report only
node scripts/dedupe-parent-subscriptions.mjs   # report only
```

The `validate:*` suites that create throwaway data (`validate:payments`,
`validate:plan-changes`, `validate:parent-plan`, `validate:stripe-connect`)
**refuse to run against a live key** by design. Do not try to defeat that —
they create real subscriptions and real charges. Test-mode runs are what prove
the code; live is proven by the preflight above plus one small real purchase
you make and refund yourself.
