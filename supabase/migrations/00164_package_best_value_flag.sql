-- 00164_package_best_value_flag.sql
--
-- The parent-facing "Best value" badge on a pack (frontends/parent's
-- dashboard.tsx BookingPage) is auto-computed from price/credits — it can
-- only ever mean "cheapest per class among this provider's packs", which
-- doesn't always match what a vendor actually wants to promote (e.g. a
-- mid-tier pack they're running a push on). This lets a vendor mark a
-- specific pack as "Best value" themselves; the parent app prefers any
-- manual picks over the auto-computed one (see dashboard.tsx), so a vendor
-- who's never touched this keeps today's behaviour unchanged.
--
-- Idempotent.

begin;

alter table public.packages
  add column if not exists best_value boolean not null default false;

comment on column public.packages.best_value is
  'Vendor-chosen "Best value" badge, shown to parents instead of the auto-computed cheapest-per-class one when the provider has set this on at least one of their packs.';

notify pgrst, 'reload schema';

commit;
