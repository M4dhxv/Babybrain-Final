-- 00082_wix_price_override.sql
--
-- Lets a vendor set their OWN price on a Wix *Bookings* activity, without the
-- next sync (the cron ticks every ~5 minutes) putting Wix's price back.
--
-- Safe to do for Bookings specifically because BabyBrain is what charges for
-- them: app/api/wix/bookings/checkout turns activities.price into its own
-- Stripe unit_amount, takes the commission as application_fee_amount and
-- transfers the rest to the vendor's connected account. Wix never sees that
-- money, so nothing reconciles the two prices.
--
-- Deliberately NOT extended to Wix Events. There the amount charged comes from
-- Wix's own live ticket reservation (computeWixCheckoutTotal in
-- app/api/wix/events/checkout) and activities.price is display-only — letting a
-- vendor edit it would advertise one price and charge another.
--
-- This also unblocks two cases that currently have no way to be priced at all:
--   * a NO_FEE Wix service (wixServicePrice -> 0) which the parent booking page
--     then routes down the free path, collecting nothing;
--   * a CUSTOM/SUBSCRIPTION service (wixServicePrice -> null) whose price the
--     sync leaves alone, so it sits on "Price on enquiry" forever.
-- Idempotent.

-- Which Wix-owned columns the vendor has claimed. lib/wix/sync.ts skips every
-- field named here on update, so the vendor's value survives each sync.
-- Deliberately general (text[]) rather than a price-only boolean — title,
-- description and image want the same treatment next and can reuse it without
-- another migration.
alter table public.activities
  add column if not exists wix_locked_fields text[] not null default '{}';

-- Wix's own price, mirrored on every sync whether or not `price` is locked.
-- Without it, an overridden activity has no way to show the vendor what Wix
-- currently says (so they can't spot that Wix's price moved), and "follow Wix
-- again" would have nothing to restore until the next cron tick.
alter table public.activities
  add column if not exists wix_price numeric(10, 2);

comment on column public.activities.wix_locked_fields is
  'Wix-owned columns the vendor has overridden; lib/wix/sync.ts leaves these alone.';
comment on column public.activities.wix_price is
  'Wix''s own price for a linked service, mirrored every sync even when price is overridden.';
