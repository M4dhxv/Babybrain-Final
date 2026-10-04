# Wix Events — how it works and how to run it

Vendors connect a Wix site with an **API key** (no installed Wix app), so Wix **webhooks are not available**: everything
that happens on the vendor's Wix after we create an order is learned by **polling**. This page is the map.

## The booking path

```
parent picks a date (a recurring series is one activity, a session per date)
  -> answers the event's own questions (from the vendor's Wix registration form)
  -> /api/wix/events/checkout   checks the LIVE event first (closed? paused? members-only? sales open? seating? tax?)
                                then reserves on Wix, creates the Stripe session (30 min)
  -> Stripe webhook / parent return / cron retry / admin Retry
       all call fulfilPaidWixEventOrder (lib/wix/finalize-event-checkout.ts)
  -> Wix order created + confirmed, tickets stored, booking row per ticket, vendor earnings recorded
```

Free tickets use `/api/wix/events/rsvp`; Wix **RSVP-type** events use `/api/wix/events/register`; **external**
events send the parent to the organiser's own site; **information-only** events can't be booked.

### Why the pre-payment check exists
A Wix *ticket reservation* does **not** check that registration is open, paused or members-only — only *checkout* does,
which for a paid ticket is after the parent has been charged. So `lib/wix/event-eligibility.ts` checks the live event
before any money moves. (This is what failed on 4 Oct 2026: a mandatory form field we didn't send.)

### Fulfilment is the one place that creates Wix orders
- **Idempotent**: an order with a Wix order number is done.
- **Race-safe**: a claim on the row (attempt counter + timestamp) — webhook vs parent-return vs cron vs admin.
- **Retry-safe**: retries make a fresh reservation but first look for an order this buyer already has on Wix and
  **adopt** it, so a seat is never sold twice.
- **Never silent**: the failure (Wix's real error) is stored on `event_ticket_orders.fulfilment_error`, the parent gets one
  "we're confirming your place" notice, and ops are emailed on the first failure and when retries run out.

## Multi-day events (e.g. a holiday camp)

Wix stores a camp that runs 9am-12pm for five days as **one event**: Mon 9:00 -> Fri 12:00, with ticket types such as
*Single Day / 3 Day Package / 5 Day Package* and no per-day schedule. `lib/wix/event-days.ts` decodes it: one session per
calendar day (in the event's time zone) between the start's time of day and the end's, shown as five 9-12 days in the vendor's
schedule and the parent's calendar. An event whose clock times don't describe a daily window (overnight, or ending at the time
it starts) is left as a single span rather than inventing days.

Booking is by day: the parent picks days, and the vendor's **ticket type decides the tickets** (a *Single Day* ticket is bought
once per child per day; an *N Day Package* needs exactly N days and is one ticket per child). A place is seated on each chosen day,
so each day's roster is right. The chosen days are on the order (`selected_days`). Limits: the ticket's day count is read from its
**name**; a Wix order carries no field for the chosen days (the vendor sees them on the BabyBrain roster); a Wix check-in is per ticket,
so it does not mark attendance for a day-by-day booking.

## The 10-minute job

`pg_cron` (migration 00219) calls `POST /api/cron/reconcile-wix-events` (secret = Vault `cron_shared_secret`, which must
equal the app's `WEBHOOK_SHARED_SECRET`). Per vendor it:

1. copies each event's registration / series metadata onto `wix_events`;
2. folds **recurring series** into one activity (`lib/wix/events-series.ts`) — adds new dates, moves changed dates
   (booked parents are notified by the `notify_session_rescheduled` trigger), cancels dropped dates;
3. works out per date **can it take a booking** and **which questions the parent must answer**;
4. reads the vendor's Wix **orders** back: cancelled/declined -> the parent's seats are cancelled as a *vendor*
   cancellation; checked-in tickets -> attendance; confirmed orders missing their seats get them;
5. reads **RSVPs** back (an explicit "no" cancels the party);
6. **retries** paid orders Wix refused (10 min, 30 min, 2 h, 6 h, 24 h; six attempts);
7. sweeps **Stripe** for paid tickets whose webhook never landed;
8. **heals** earnings rows recorded without Stripe's facts (`healEarningsFromStripe`).

It stamps `activities.wix_event_checked_at`; **Admin → Needs attention** warns if that goes stale (> 1 hour).

## When something needs a person

| You see | Meaning | Do |
|---|---|---|
| Email "ACTION NEEDED: paid event ticket not created on Wix" | A parent paid; Wix refused the order | Read "Wix said". Fix it on the vendor's Wix (or it may fix itself), then **Admin → Payments → Retry**. Or **Refund**. |
| Admin → Needs attention: "paid event tickets not on the vendor's Wix" | Same, as a standing list | As above |
| "Wix event ticket cancelled by the vendor" email | The vendor cancelled an order on Wix | The seat was cancelled and a make-up token issued. Refund in Stripe if you'd rather. |
| "Wix event order total differs from what the parent paid" | Tax / price changed between page and checkout | Ticket was issued; reconcile the difference with the vendor. |
| "Wix Events aren't being re-checked" | The 10-minute job stopped | Check the cron job, the route, and the secret match. |

**Refunds**: Admin → Payments → Refund refunds the parent in full (reversing the Connect transfer and application fee).
Wix has **no cancel-order API** — if the order exists on the vendor's Wix, cancel it there too; the next job run then
sees it cancelled and keeps both sides consistent.

## What is deliberately NOT supported (blocked before payment, with a clear message)

Tax added at checkout, donation / pay-what-you-want tickets, seating plans, members-only events. Wix events also have
**no BabyBrain waitlist** (migration 00107): a full event is just full. Parents can't cancel event tickets themselves.

## Shipping this

1. Apply migrations **00218, 00219, 00221** (`supabase db push` applies every pending migration — check what else is pending).
2. `node scripts/preship-wix-events.mjs` must say READY.
3. Push. The first job run folds each vendor's per-date event activities into series activities and exposes **all** dates
   of an imported series once the series activity is published.
4. Make one real test booking and one test cancellation on a vendor's test event.

## Tests

- `npx tsx scripts/validate-wix-events-logic.mts` — pure decisions (eligibility, forms, series planning, earnings split).
- `npx tsx scripts/validate-wix-events-flow.mts` — runs the real fulfilment / reconcile code against an in-memory
  database and a fake Wix: races, refusal, retry, adoption, series folding, cancellation, check-in, RSVP.

## Keep in step

`supabase/functions/_shared/wix-events-sync.ts` is a **Deno copy** of the 15-minute sync. Series activities
deliberately have no `wix_event_id`, so it never touches them; don't change that. New Events logic lives in the Vercel
reconcile job so it isn't duplicated.
