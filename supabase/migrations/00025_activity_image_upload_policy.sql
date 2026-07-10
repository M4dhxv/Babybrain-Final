-- 00025_activity_image_upload_policy.sql
-- The public `activity-images` bucket only had a read policy, so the vendor
-- portal's "Upload image" (Create/Edit Activity drawer) had no way to write.
-- Let provider members upload/replace images under their own provider's
-- folder: activity-images/<provider_id>/<filename>.

drop policy if exists "vendors upload activity images" on storage.objects;
create policy "vendors upload activity images"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'activity-images'
    and (storage.foldername(name))[1] in (
      select id::text from public.providers
      where id in (select public.user_manage_provider_ids())
    )
  );

drop policy if exists "vendors update own activity images" on storage.objects;
create policy "vendors update own activity images"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'activity-images'
    and (storage.foldername(name))[1] in (
      select id::text from public.providers
      where id in (select public.user_manage_provider_ids())
    )
  );
