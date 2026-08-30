-- Whenever live Wix availability is fetched (parent picker or vendor
-- Schedule calendar), a local activity_sessions row is now upserted for
-- every slot Wix reports — not just the ones that get booked through
-- BabyBrain. `capacity` holds the true total (from Wix); this new column
-- holds Wix's live remaining count, since our own `bookings` table only
-- sees bookings made through us and can't tell how full a Wix-direct
-- booking has made a slot. See app/api/wix/slots.
-- Idempotent.

alter table public.activity_sessions
  add column if not exists wix_remaining_capacity int;
