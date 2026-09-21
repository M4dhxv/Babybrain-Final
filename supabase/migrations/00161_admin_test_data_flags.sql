-- 00161_admin_test_data_flags.sql
--
-- Keep demo and test activity out of the founder's admin Metrics and Payments.
--
-- Production and preview deployments share one database, and demo vendors
-- (BabyBrain Demo Provider, Ind-SG Kids Centre...) have made test purchases in it.
-- Those rows are real rows, so they were being counted as revenue, commission and
-- bookings on /admin. Nothing is deleted here: rows are only tagged so the admin
-- pages can leave them out by default (there is an "include test data" switch).
--
-- Idempotent.

-- 1. A vendor can be marked as a test/demo account. Everything they own (their
--    activities, bookings, earnings) is then treated as test data by /admin.
alter table public.providers
  add column if not exists is_test boolean not null default false;

comment on column public.providers.is_test is
  'Demo / QA / sandbox vendor. Excluded from the admin Metrics and Payments unless "include test data" is on. Set from the admin Commercials tab.';

-- 2. Whether a sale was taken in Stripe live mode. Sales from the test site use
--    Stripe test keys, so they arrive with livemode = false and are excluded
--    from admin totals. Rows written before this migration are treated as live;
--    their vendors are covered by is_test below.
alter table public.provider_earnings
  add column if not exists livemode boolean not null default true;

comment on column public.provider_earnings.livemode is
  'false = a Stripe test-mode payment (test site). Excluded from the admin Payments and Metrics totals.';

-- 3. Tag the demo / QA vendors found in the live database on 2026-09-21. This is
--    the only data change: the rows stay, they are just marked.
update public.providers
set is_test = true
where business_name in (
        'BabyBrain Demo Provider',
        'Ind-SG Kids Centre',
        'Katie Vendor Account',
        'QA Test Studio',
        'Sandbox Test Studio'
      )
   or business_name like 'QA Test Studio qa-%'
   or business_name like 'ZZ Supabase Proof%';
