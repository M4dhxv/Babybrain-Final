-- 00219_wix_event_orders_reliability.sql
--
-- Wix Events tickets: make a paid-but-unfulfilled order recoverable, give parents their tickets, and
-- let BabyBrain learn what happens to an order on the vendor's Wix side.
--
-- Background: on 4 Oct 2026 a parent paid for a BeAlere ticket and Wix refused the order
-- (INVALID_FORM_RESPONSE). The order was left `pending` + `paid` with nothing but a console.error:
-- no record of why, no retry, no ticket. Three gaps closed here:
--
-- 1. event_ticket_orders keeps *why* fulfilment failed and how often it was tried, so an admin (and a
--    background retry) can act on it. "Needs attention" is simply status = 'pending' AND
--    payment_status = 'paid'.
-- 2. Tickets are stored. Wix issues each ticket a number and a permanent check-in URL (the QR code).
--    The PDF / wallet-pass links Wix returns are signed and expire within about a day, so they are
--    NOT stored — they are fetched fresh from Wix when a parent asks for them.
-- 3. The state of the order on the vendor's Wix site (cancelled, refunded, checked in, ...) is read
--    back periodically (a webhook needs an installed Wix app; we only hold the vendor's API key).
--    wix_order_status / wix_synced_at record what was last seen.
--
-- activities gets a snapshot of whether the Wix event can currently take a booking (registration
-- closed, members only, tax added at checkout, ...) so the parent page can say so up front instead of
-- taking a payment Wix will refuse, and the vendor portal can show what to change in Wix.
--
-- Idempotent.

alter table public.event_ticket_orders
  add column if not exists fulfilment_error text,
  add column if not exists fulfilment_attempts int not null default 0,
  add column if not exists fulfilment_last_attempt_at timestamptz,
  add column if not exists tickets jsonb not null default '[]'::jsonb,
  add column if not exists wix_order_status text,
  add column if not exists wix_synced_at timestamptz,
  add column if not exists refunded_at timestamptz,
  add column if not exists stripe_refund_id text;

comment on column public.event_ticket_orders.fulfilment_error is
  'Why the Wix order could not be created after payment (last attempt). Null once fulfilled.';
comment on column public.event_ticket_orders.tickets is
  'Issued tickets: [{ticketNumber, checkInUrl}]. checkInUrl is the permanent QR target; signed PDF links expire, so they are not kept.';
comment on column public.event_ticket_orders.wix_order_status is
  'The order''s status on the vendor''s Wix site when last read (PAID, FREE, CANCELED, ...).';

-- The retry job and the admin queue both look for paid orders still waiting on Wix.
create index if not exists event_ticket_orders_unfulfilled_idx
  on public.event_ticket_orders (created_at)
  where status = 'pending' and payment_status = 'paid';

-- The reconcile job walks confirmed orders per event.
create index if not exists event_ticket_orders_confirmed_event_idx
  on public.event_ticket_orders (event_id)
  where status = 'confirmed';

alter table public.activities
  add column if not exists wix_event_blockers jsonb not null default '[]'::jsonb,
  add column if not exists wix_event_checked_at timestamptz;

comment on column public.activities.wix_event_blockers is
  'Why this Wix event cannot take a booking right now: [{code, vendorMessage, parentMessage}]. Empty = bookable.';

-- Reconcile every 10 minutes: re-read each Wix event's state, retry paid-but-unfulfilled orders, and
-- pull cancellations / check-ins back from Wix. Calls the Vercel route (one implementation; the
-- Deno copy of the sync is not involved).
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid) from cron.job where jobname = 'reconcile-wix-events';
select cron.schedule(
  'reconcile-wix-events',
  '*/10 * * * *',
  $$
  select net.http_post(
    url     := public.app_base_url() || '/api/cron/reconcile-wix-events',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_shared_secret')
    ),
    body    := '{}'::jsonb
  );
  $$
);

notify pgrst, 'reload schema';
