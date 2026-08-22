-- Wix Bookings integration — a provider's real availability can live in
-- Wix instead of being hand-entered as activity_sessions. Slots are fetched
-- live from the Wix API; a local activity_sessions row is only materialized
-- at the moment a slot is actually booked (see app/api/wix/bookings), so the
-- existing capacity/waitlist trigger and every downstream feature that reads
-- bookings/activity_sessions keeps working unmodified.
-- Idempotent.

alter table public.providers
  add column if not exists wix_site_id text;

alter table public.activities
  add column if not exists wix_service_id text,
  add column if not exists wix_resource_id text;

alter table public.activity_sessions
  add column if not exists wix_slot_key text;

-- Plain (non-partial) unique index: Postgres treats every NULL as distinct,
-- so manually-created sessions (wix_slot_key null) are unaffected, while
-- Wix-sourced ones dedupe on (activity_id, wix_slot_key) — and the plain
-- index (no predicate) is required for it to work as an upsert target via
-- supabase-js's `onConflict`.
create unique index if not exists activity_sessions_wix_slot_key_idx
  on public.activity_sessions (activity_id, wix_slot_key);

alter table public.bookings
  add column if not exists wix_booking_id text;
