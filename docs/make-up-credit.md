# Make-up credit (migration 00276)

A make-up token used to be **one booking**. It is now **money kept with one vendor**. The product name stays
"make-up token" (packs already use the word "credit").

```
balance with a vendor: $40
buys a $25 class                 -> $15 left
cancels a $20 booking            -> $35
books a $50 class                -> uses $35, pays $15 by card
```

## Rules

- **Vendor scope.** A parent's tokens with one vendor add up to one balance. Credit with vendor A can never pay
  for vendor B. A parent with credit at two vendors sees two balances, each with the vendor's name.
- **Spend it on anything that vendor sells:** a single session or a party of seats, a pack, extra people
  (add-ons), a Wix-linked class. The card pays whatever the balance does not cover.
- **Expiry follows the old token rules.** Each token is a *lot* with its own expiry: an automatic one (from a
  cancellation) never expires, a vendor can set an expiry on a token they issued. Spending takes the lot that
  expires soonest first, an unexpiring lot last.
- **Cancelling gives the money back as credit, never cash.** The part that was paid with credit goes back to
  the lots it came from (a lapsed lot gets a fresh 30 days, as a returned token always did). The part paid by
  card becomes a new automatic lot. A vendor's "no refund" cancel gives nothing back. A booking cancelled
  before it was ever paid for (an abandoned checkout) just gives its credit back.
- **A vendor issuing a token by hand** gets a token worth what that booking cost (decided 17 Nov: fixed to
  class price). They can still set an expiry, but nobody with portal access can type an amount or edit a
  balance (trigger `make_up_tokens_guard`).
- **Stripe's 50c minimum.** Credit never leaves the card with a charge between 1c and 49c: the card keeps 50c
  and the credit pays less. Same rule in the server and in the booking page.
- **BabyBrain's cut and the vendor's earnings** are on the card part only. The vendor was paid for the credit
  part when that credit was first bought, so it is not a new sale.

## Data

| Thing | What it is |
|---|---|
| `make_up_tokens.amount_cents` / `balance_cents` | A lot: what it was issued for, what is left. `status` is `issued` while a balance remains, `redeemed` once spent. |
| `make_up_token_spends` | The ledger. Each row takes `amount_cents` out of one lot for one purchase. `held` (reserved while on the Stripe page) -> `applied` (purchase settled) or `returned`. |
| `bookings.credit_cents` | How much of that seat credit paid. |
| `bookings.paid_by_credit` | True when credit paid the whole seat. `payment_status` stays `none` for these, as for a redeemed token booking before. |
| `booking_addons.credit_cents` | Same, for an add-on row. |

Functions (all service-role only except `my_make_up_credit`):
`make_up_credit_balance`, `reserve_make_up_credit`, `return_make_up_credit`, `release_make_up_credit_hold`,
`settle_make_up_credit_hold`, `confirm_credit_booking_seats`, `release_stale_make_up_credit_holds` (cron every 15
min), and `my_make_up_credit()` (a parent's own balances, one row per vendor).

## How a purchase uses it

`lib/make-up-credit.ts`. Every checkout does: work out the total and its pieces, `reserveCredit` for what the
balance covers, charge the card for the rest (or nothing), settle on payment, give back if it never settles.

| Checkout | Credit follows | Released when |
|---|---|---|
| `/api/bookings/checkout` (sessions, parties, add-ons riding along) | the seat rows and add-on rows | seat cancelled / back to waitlist / row deleted (database triggers) |
| `/api/bookings/addons/checkout` | the add-on rows | row deleted or cancelled |
| `/api/customer/stripe/package` | a hold id in the Stripe metadata | `checkout.session.expired` / `async_payment_failed`, or the 15-minute sweep after 90 min |
| `/api/wix/bookings/checkout` | the seat rows | seat cancelled by the expiry handler |

A seat keeps its credit across Stripe attempts, so a parent who retries is not charged the credit twice.
Fully covered by credit: no Stripe; seats are confirmed with `confirm_credit_booking_seats` (same session lock
and capacity re-check as a card payment) and the route returns the `/booked` URL directly.

## Old code keeps working during a deploy

The migration is additive. `redeem_make_up_token(token, session, ...)` is kept as a shim for a page opened
before the deploy: it pays the class from the whole vendor balance if the balance covers it, and refuses with a
clear message if not. `/api/wix/bookings/redeem-token` is retired (410) and tells the parent to reload.

## Not done yet

- **Wix event tickets** (`/api/wix/events/checkout`). Credit is not offered on a ticketed event; the booking
  page hides it there.
- **Terms and monthly billing** live on the `features-test` branch, not this one. The functions above are
  built to be reused; the checkout for each needs the same few lines as the session checkout when it merges.
- **Add-on refunds on cancel** (already an open item from 00273): cancelling a booking does not refund its
  add-ons, with or without credit.
- Vendor-side issuing dialogs are unchanged (a token is worth what the booking cost; a free booking cannot be
  issued one and says so).

## Status

- **Production: applied 2026-11-17** (rehearsed first in a rolled-back transaction, then applied and recorded as version 00276 in one transaction). Backfill: 32 tokens, 7 priced from their bookings or class price, 19 unspent tokens worth $0 (all on the two test vendors, no booking behind them). Real balances: Happy Circle $65, Little Blue Chair $45, Physio Down Under $55.
- **Test database: not applied.** Its password still fails. Run `test-db-apply-00276.sql` in the test project's SQL editor.
- **Code is not deployed yet.** The migration is safe with the old code (shim in section 8 of the migration).

## Before it ships

1. Apply `00276` to the **test** database first. It needs `00273` (add-ons) and `00270` (admin booking) in
   place; apply them first or together. Check the NOTICE at the end of the backfill: it reports how many unspent
   tokens could not be priced and are worth $0 (a vendor-issued token whose booking had no amount and whose class
   has no price).
2. Apply to production **before** the code deploy. The migration works with the old code; the new code does not
   work without the migration (the Profile page selects the new columns).
3. `node scripts/check-migration-regressions.mjs` and `node scripts/check-exposed-functions.mjs` (the latter
   needs the DB URL) before `supabase db push`.
4. Tests, no database needed: `node supabase/tests/00276_make_up_credit.test.mjs` and
   `node supabase/tests/00276_admin_token.test.mjs`.
5. Smoke check, then test with a real card on the test site: partly covered, fully covered, then cancel each and
   confirm the balance.
