-- 00071_event_ticket_fee_type.sql
--
-- Both the parent-facing booking page and the vendor's own activity price
-- field were showing the bare ticket price, but the real charge (already
-- correct server-side — computeWixCheckoutTotal in lib/wix/client.ts) can
-- be higher: Wix adds its own service fee on top for FEE_ADDED_AT_CHECKOUT
-- ticket types, confirmed live (a 100.00 ticket becomes a 102.50 charge).
-- `fee_type` mirrors Wix's own enum. The exact fee *rate* is never present
-- on the ticket definition itself — only a live reservation returns it
-- (serviceFee.rate) — so `fee_rate_percent` is populated by lib/wix/events-
-- sync.ts making one throwaway dry-run reservation the first time a
-- FEE_ADDED_AT_CHECKOUT ticket type is seen (auto-released by Wix in
-- 20-30 min, never checked out), then cached here so every later sync
-- reuses it instead of reserving inventory again. Together the two columns
-- let every price shown ahead of checkout (booking page total, ticket
-- picker, vendor's activity price field) be the real inclusive total
-- instead of an understated one. Idempotent.

alter table public.event_ticket_types
  add column if not exists fee_type text
    check (fee_type in ('FEE_INCLUDED', 'FEE_ADDED_AT_CHECKOUT', 'NO_FEE'));

alter table public.event_ticket_types
  add column if not exists fee_rate_percent numeric;
