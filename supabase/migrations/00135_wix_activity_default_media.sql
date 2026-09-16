-- 00135_wix_activity_default_media.sql
--
-- Wix-synced activities never had "no image/description of their own ->
-- fall back to the provider's default" applied the way native activities
-- do:
--
--   * image_source (00130) defaults to 'profile' on every insert, and
--     lib/wix/sync.ts never set it to 'custom' — so any activity with its
--     own real synced photo (image_urls) still got outranked by the
--     provider's catalogue in resolveActivityImages (frontends/parent's
--     activityMedia.ts), which only prefers an activity's own images when
--     image_source = 'custom'.
--   * description defaulted to the hardcoded "Imported from Wix. Finish
--     this listing..." placeholder on first import whenever Wix had no
--     description, rather than staying empty so the parent-facing detail
--     page's existing fallback (activity.description || provider's own
--     description, App.tsx's InfoBlock) could do its job.
--
-- Application code (lib/wix/sync.ts) is fixed separately for activities
-- synced from here on; this backfills the ones that already exist.
--
-- Idempotent — both updates only touch rows still at the old default
-- values, so running this twice is a no-op the second time.

begin;

-- Only flips a row that actually has a real photo of its own; one with no
-- image_urls stays at 'profile' (correctly falling back to the provider),
-- same as a freshly-synced activity with no Wix photo would.
update public.activities
set image_source = 'custom'
where wix_service_id is not null
  and image_source = 'profile'
  and image_urls is not null
  and array_length(image_urls, 1) > 0;

-- Clears the leaked "Imported from Wix..." placeholder so the existing
-- provider-description fallback on the parent-facing detail page applies,
-- instead of a vendor-facing TODO note showing up as the activity's actual
-- description.
update public.activities
set description = ''
where wix_service_id is not null
  and description = 'Imported from Wix. Finish this listing — category, age range and description — then publish it when ready.';

commit;
