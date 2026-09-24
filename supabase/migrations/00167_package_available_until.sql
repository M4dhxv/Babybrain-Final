-- 00167_package_available_until.sql
--
-- starts_at (00134) let a vendor schedule when a pack goes on sale, but
-- there was no matching way to schedule when it goes OFF sale — vendors had
-- to reuse expiry_date for that, which conflated "stop selling this pack"
-- with "this is when a parent's credits run out" (a per-purchase concern,
-- stamped by stamp_package_purchase_expiry from validity_days/expiry_date,
-- 00132). available_until is the missing half of the sale window: null
-- means still on sale indefinitely, set means the pack stops being
-- purchasable/listed once it's passed. It never feeds a purchase's
-- expires_at — that stays entirely the vendor's expiry_date/validity_days
-- choice, computed from each purchase's own created_at.
--
-- Idempotent.

begin;

alter table public.packages
  add column if not exists available_until timestamptz;

notify pgrst, 'reload schema';

commit;
