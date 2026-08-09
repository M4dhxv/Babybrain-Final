-- 00038_merge_duplicate_provider.sql
--
-- "Little joy play" ended up listed twice. The seed spreadsheet carried the
-- business under a typo'd name with an internal note attached — "Littel joy
-- play (see other s/s for url)" — and the crawl kept that string, so the
-- importer treated it as a new business and created a second provider. The
-- note was rendering to parents as the business name.
--
-- The duplicate is the one with the real data: 4 published classes and all six
-- venue addresses, while the canonical row had a single class and the
-- placeholder address "Six venues across Singapore". So the content moves onto
-- the canonical row rather than the other way round.

do $$
declare
  keep_id uuid;
  drop_id uuid;
begin
  select id into keep_id from public.providers where slug = 'little-joy-play';
  select id into drop_id from public.providers
   where slug = 'littel-joy-play-see-other-s-s-for-url';

  if keep_id is null or drop_id is null then
    raise notice 'nothing to merge (keep=% drop=%)', keep_id, drop_id;
    return;
  end if;

  -- Anything pointing at the duplicate now points at the survivor.
  update public.activities         set provider_id = keep_id where provider_id = drop_id;
  update public.provider_locations set provider_id = keep_id where provider_id = drop_id;

  -- Take the duplicate's real address over the placeholder.
  update public.providers p
     set address     = coalesce(d.address, p.address),
         postal_code = coalesce(d.postal_code, p.postal_code),
         latitude    = coalesce(p.latitude, d.latitude),
         longitude   = coalesce(p.longitude, d.longitude),
         website     = coalesce(p.website, d.website),
         contact_email = coalesce(p.contact_email, d.contact_email),
         contact_phone = coalesce(p.contact_phone, d.contact_phone),
         whatsapp      = coalesce(p.whatsapp, d.whatsapp)
    from public.providers d
   where p.id = keep_id and d.id = drop_id;

  -- Drop the placeholder location if real ones came across with the merge.
  delete from public.provider_locations
   where provider_id = keep_id
     and (address is null or address = 'Six venues across Singapore')
     and exists (
       select 1 from public.provider_locations l2
        where l2.provider_id = keep_id and l2.address is not null
          and l2.address <> 'Six venues across Singapore');

  delete from public.providers where id = drop_id;

  -- provider_name is denormalised onto activities and feeds the card's purple
  -- provider line, so it has to be corrected too.
  update public.activities set provider_name = 'Little joy play' where provider_id = keep_id;

  raise notice 'merged % into %', drop_id, keep_id;
end $$;

-- Re-derive the region now that a real address is attached.
update public.providers p
   set region = public.sg_region(p.postal_code, p.latitude, p.longitude)
 where p.slug = 'little-joy-play';

update public.activities a
   set region = coalesce(
         public.sg_region(a.postal_code, a.latitude, a.longitude),
         (select public.sg_region(l.postal_code, l.latitude, l.longitude)
            from public.provider_locations l
           where l.provider_id = a.provider_id and l.postal_code is not null
           limit 1))
 where a.region is null;

notify pgrst, 'reload schema';
