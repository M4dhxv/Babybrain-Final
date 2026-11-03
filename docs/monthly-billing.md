# Monthly billing

Migration `00268_monthly_billing.sql`. Built on branch `monthly-billing` from `features-test`. Not on `main`; not applied to any database yet.

## What it does

A vendor switches an activity to **Bill this activity monthly** (Activities → edit → "Who, where and how much"). Then:

- A parent **enrols once** (a tick-box on the booking page), then books **any number of sessions** through the normal flow. Nothing is paid at booking; the seat is confirmed straight away.
- On the **1st** of each month, `monthly_billing_daily()` (pg_cron, 09:00 Singapore) issues one invoice per enrolment for the sessions in the **month just ended**: every seat that is not cancelled, waitlisted or pending, at the session price as of that day. Free sessions cost nothing and are left off.
- The invoice is due by the **end of the 5th** (`due_at` is 00:00 on the 6th). The parent pays through a Stripe Checkout link (`/api/customer/monthly/checkout`), split to the vendor's Connect account like a booking.
- Two days before the deadline a reminder goes out; after it, the parent and the vendor are told.
- **Overdue blocks new bookings** in that activity (and a fresh enrolment). Sessions already booked are untouched. "Overdue" is not a stored status: it is an open invoice whose `due_at` has passed, so the block takes effect on time without any job running.
- **14 days' notice** to leave. Giving notice on day D means the last session day is D+14. Seats booked after that are cancelled at once, with no charge. Notice can be taken back until it runs out. A final invoice follows on the 1st.
- A vendor can mark an invoice **paid outside the app** or **waive** it (Monthly billing page).

## Where things are

| Piece | File |
| --- | --- |
| Tables, gate trigger, RPCs, daily job | `supabase/migrations/00268_monthly_billing.sql` |
| SQL tests (PGlite, 47 checks) | `supabase/tests/00268_monthly_billing.test.mjs` |
| Pay link | `app/api/customer/monthly/checkout/route.ts` |
| Mark paid (webhook + return from Stripe) | `lib/monthly-invoice-payment.ts`, `app/api/webhooks/stripe/route.ts`, `app/api/stripe/reconcile/route.ts` |
| Emails | `lib/emails/render.ts` (`monthly_*`, `provider_monthly_*`) |
| Vendor: switch + page | `frontends/vendor/src/lib/monthlyBilling.ts`, `pages/MonthlyBillingPage.tsx`, `pages/ActivitiesPage.tsx` |
| Parent: booking, account tab | `frontends/parent/src/lib/monthly.ts`, `components/MonthlyPanel.tsx`, `pages/BookingPage.tsx`, `pages/ProfilePage.tsx` |

## Rules the database enforces

- Not available for Wix-synced activities, and not alongside terms (a check constraint, added only where `terms_enabled` exists).
- A parent's booking on a monthly activity needs an enrolment that has not passed its end date. Package credits are refused. Vendor manual bookings and the service role are not billed to a parent.
- Monthly billing can't be switched off while a family is enrolled or owes an invoice.

## Running the SQL tests

```
npm i --no-save @electric-sql/pglite
node supabase/tests/00268_monthly_billing.test.mjs
```

## Not covered

Late fees, a flat monthly price, vendor-side ending of an enrolment, per-child enrolment, make-up tokens on a monthly activity (they would be billed), rescheduling a monthly booking to a session past the notice date, and an admin view.
