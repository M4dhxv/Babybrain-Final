-- 00076_provider_terms_acceptance.sql
--
-- "Save your listing" collects two "I agree" ticks — Vendor Terms and Booking
-- & Messaging Terms — but had nowhere to record them: the Save button only
-- navigated, and SettingsPage's Compliance tab showed "Accepted" for every
-- provider on faith (see frontends/vendor/src/lib/complianceTerms.ts, and the
-- note in SettingsPage.tsx). Give the acceptance a real per-provider
-- timestamp so Save can persist it.
--
-- Idempotent.

alter table public.providers
  add column if not exists vendor_terms_accepted_at timestamptz,
  add column if not exists booking_messaging_terms_accepted_at timestamptz;

comment on column public.providers.vendor_terms_accepted_at is
  'When the owner accepted the Vendor Terms on the Save-your-listing step. NULL = not yet accepted.';
comment on column public.providers.booking_messaging_terms_accepted_at is
  'When the owner accepted the Booking & Messaging Terms (required before taking bookings on a paid plan). NULL = not yet accepted.';

-- No RLS change needed: owners/managers already update their own providers row
-- (the vendor portal writes these the same way it writes business_name etc.).
