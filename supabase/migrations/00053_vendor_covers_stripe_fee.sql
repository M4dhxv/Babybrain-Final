-- 00053_vendor_covers_stripe_fee.sql
--
-- Aligns the implemented commercial model with the published one.
--
-- The pricing deck advertises every paid tier as "<x>% booking commission +
-- Stripe platform costs + GST", i.e. the vendor absorbs Stripe's processing
-- fee. 00051 introduced `fee_payer` but defaulted it to 'platform' — the
-- behaviour that existed before it — so BabyBrain was still absorbing the fee
-- and netting ~11% on a nominal 15% deal.
--
-- Safe to apply as a blanket change at this point: no vendor has completed
-- Stripe Connect onboarding yet and no earnings have been recorded, so this
-- re-prices nobody mid-flight.
--
-- Charges remain destination charges — the fee is recovered through the
-- application fee, so this moves the *cost* to vendors without moving
-- chargeback liability to them. See lib/commercials.ts.
--
-- Idempotent.

-- Every existing vendor, including bespoke deals: `custom_terms` protects a
-- negotiated *rate* from plan changes, not who pays Stripe. Set fee_payer back
-- to 'platform' per vendor in /admin → Commercials to grant an exception.
update public.subscriptions set fee_payer = 'vendor' where fee_payer <> 'vendor';

-- And new vendors, so this doesn't silently revert for every future signup —
-- the same way the old 0.150 commission default kept reasserting itself.
alter table public.subscriptions alter column fee_payer set default 'vendor';
