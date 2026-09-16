-- 00134_package_start_date.sql
--
-- Packages could only be switched on/off by hand (`active`) — no way for a
-- vendor to schedule a pack to go live at a future date/time (e.g. "term 2
-- starts 1 Oct"). starts_at adds that: null means available immediately
-- (today's behaviour, unchanged), set means the pack is "upcoming" until
-- that instant and only purchasable/listed once it's passed.
--
-- This is purely a launch gate on the *pack*, independent of expiry_date /
-- validity_days (00132/00026), which govern when a *purchase* runs out.
--
-- Idempotent.

begin;

alter table public.packages
  add column if not exists starts_at timestamptz;

notify pgrst, 'reload schema';

commit;
