-- Every service on a vendor's connected Wix account (appointment or class)
-- gets its own activities row, kept in sync by provider+service rather than
-- by slug — so re-syncing after new Wix services are added never creates
-- duplicates. See app/api/vendor/wix-services-sync.
-- Idempotent.

create unique index if not exists activities_provider_wix_service_idx
  on public.activities (provider_id, wix_service_id)
  where wix_service_id is not null;
