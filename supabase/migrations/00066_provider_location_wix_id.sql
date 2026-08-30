-- 00066_provider_location_wix_id.sql
--
-- Settings -> Locations gains a "Fetch from Wix" action (GET
-- /api/vendor/wix-locations, POST /api/vendor/wix-locations-import) that
-- imports a vendor's real Wix business address instead of retyping it.
-- wix_location_id records which Wix location a row was imported from, so a
-- repeat fetch can tell "already imported" apart from a genuinely new one
-- instead of creating a duplicate row every time.
alter table public.provider_locations add column if not exists wix_location_id text;

drop index if exists provider_locations_wix_location_id_idx;
create unique index provider_locations_wix_location_id_idx
  on public.provider_locations (provider_id, wix_location_id)
  where wix_location_id is not null;
