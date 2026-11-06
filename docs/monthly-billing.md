# Monthly billing

Migrations `00268_monthly_billing.sql` and `00271_monthly_billing_optional.sql`. Built on branch `monthly-billing` from `features-test`. Not on `main`.

## What it does

A vendor switches **Offer monthly billing** on for an activity (Activities → edit → "Who, where and how much"). That makes monthly billing a **choice**: a parent who does not choose it books and pays exactly as before (per booking through Stripe, package credits, make-up tokens). For a parent who does:

- On the booking page the parent picks **Pay now** (the default) or **Monthly billing**. Choosing monthly means they **enrol once** (a tick-box), then book **any number of sessions** through the normal flow. Nothing is paid at booking; the seat is confirmed straight away.
- On the **1st** of each month, `monthly_billing_daily()` (pg_cron, 09:00 Singapore) issues one invoice per enrolment for the sessions in the **month just ended**: every seat that is not cancelled, waitlisted or pending, at the session price as of that day. Free sessions cost nothing and are left off.
- The invoice is due by the **end of the 5th** (`due_at` is 00:00 on the 6th). The parent pays through a Stripe Checkout link (`/api/customer/monthly/checkout`), split to the vendor's Connect account like a booking.
- Two days before the deadline a reminder goes out; after it, the parent and the vendor are told.
- **Overdue blocks new bookings** in that activity, enrolled or not and however they would have paid (and a fresh enrolment). Sessions already booked are untouched. "Overdue" is not a stored status: it is an open invoice whose `due_at` has passed, so the block takes effect on time without any job running.
- **14 days' notice** to leave. Giving notice on day D means the last session day is D+14. Seats booked after that are cancelled at once, with no charge. Notice can be taken back until it runs out. A final invoice follows on the 1st.
- A vendor can mark an invoice **paid outside the app** or **waive** it (Monthly billing page).

## Where things are

| Piece | File |
| --- | --- |
| Tables, gate trigger, RPCs, daily job | `supabase/migrations/00268_monthly_billing.sql` |
| Monthly billing is a choice (gate rewritten) | `supabase/migrations/00271_monthly_billing_optional.sql` |
| SQL tests (PGlite) | `supabase/tests/00268_monthly_billing.test.mjs` (47), `supabase/tests/00271_monthly_billing_optional.test.mjs` (18) |
| Pay link | `app/api/customer/monthly/checkout/route.ts` |
| Mark paid (webhook + return from Stripe) | `lib/monthly-invoice-payment.ts`, `app/api/webhooks/stripe/route.ts`, `app/api/stripe/reconcile/route.ts` |
| Emails | `lib/emails/render.ts` (`monthly_*`, `provider_monthly_*`) |
| Vendor: switch + page | `frontends/vendor/src/lib/monthlyBilling.ts`, `pages/MonthlyBillingPage.tsx`, `pages/ActivitiesPage.tsx` |
| Parent: booking, account tab | `frontends/parent/src/lib/monthly.ts`, `components/MonthlyPanel.tsx`, `pages/BookingPage.tsx`, `pages/ProfilePage.tsx` |

## Rules the database enforces

- Not available for Wix-synced activities, and not alongside terms (a check constraint, added only where `terms_enabled` exists).
- (00271) A parent who has not enrolled books the ordinary way. An enrolled parent's booking is confirmed unpaid and goes on the monthly invoice; while enrolled every booking in that activity is monthly, so a package credit is refused. Giving notice and leaving returns them to paying per booking. Vendor manual bookings and the service role are never billed to a parent.
- Monthly billing can't be switched off while a family is enrolled or owes an invoice.

## Running the SQL tests

```
npm i --no-save @electric-sql/pglite
node supabase/tests/00268_monthly_billing.test.mjs
node supabase/tests/00271_monthly_billing_optional.test.mjs
```

## Not covered

Mixing within one enrolment (a pack credit or make-up token on a monthly activity), late fees, a flat monthly price, vendor-side ending of an enrolment, per-child enrolment, make-up tokens on a monthly activity (they would be billed), rescheduling a monthly booking to a session past the notice date, and an admin view.
