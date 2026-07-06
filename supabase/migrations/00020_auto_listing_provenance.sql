-- BabyBrain — support auto-listed (unclaimed, directory) vendors.
-- Providers we seed from the crawl/enrich pipeline are marked is_auto_listed so
-- the nightly sync can refresh them but must NEVER touch a claimed vendor's
-- self-managed data. While a listing is unclaimed / not bookable on-platform,
-- an activity carries the provider's own booking link so "Book" redirects out.
-- Idempotent.

alter table public.providers
  add column if not exists is_auto_listed boolean not null default false,
  add column if not exists source_url text,
  add column if not exists synced_at timestamptz;

alter table public.activities
  add column if not exists external_booking_url text;
