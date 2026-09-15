-- 00130_activity_image_source.sql
--
-- Provider profile media (logo_url/cover_image_url/gallery_urls/description,
-- added by 00074) has sat unused since — nothing on the parent side ever
-- read it, so a vendor's uploaded photos and "about" text never reached any
-- activity. This gives each activity an explicit choice instead of forcing
-- vendors to re-upload the same photos per class:
--
--   image_source 'profile' (default) — this activity borrows the provider's
--     own cover/logo/gallery for its parent-facing images.
--   image_source 'custom'            — this activity has its own photos
--     (activities.image_urls, unchanged column, now vendor-editable as a
--     real up-to-10 array instead of the single-URL form it was stuck at).
--
-- cover_image_url is an explicit pick that works either way: in 'profile'
-- mode it must be one of the provider's own images, in 'custom' mode one of
-- the activity's own — the app resolves the final display order from
-- whichever source is active, cover first. Kept separate from "index 0 of
-- image_urls" (the old implicit convention) because in 'profile' mode there
-- may be no activity-owned image_urls at all to index into.
--
-- Backfill: any activity that already has real image_urls is switched to
-- 'custom' so existing vendor-uploaded photos aren't silently replaced by
-- the provider's generic catalogue the moment this ships — 'profile' is the
-- default for anything with nothing of its own, matching what "the vendor
-- hasn't set an image" actually means today.
--
-- Idempotent.

begin;

alter table public.activities
  add column if not exists image_source text not null default 'profile'
    check (image_source in ('profile', 'custom')),
  add column if not exists cover_image_url text;

comment on column public.activities.image_source is
  'Where this activity''s parent-facing images come from: the provider''s '
  'own profile media (default), or this activity''s own image_urls.';
comment on column public.activities.cover_image_url is
  'Explicit cover pick for this activity — one of the provider''s images '
  '(image_source=profile) or one of this activity''s own image_urls '
  '(image_source=custom). Falls back to the first available image when null.';

update public.activities
set image_source = 'custom'
where image_source = 'profile'
  and image_urls is not null
  and array_length(image_urls, 1) > 0;

-- ---------- search_activities: carry image_source/cover + provider media ----------
-- Return-column change, so the old signature has to be dropped first —
-- create or replace can't add/reorder output columns in place.
drop function if exists public.search_activities(
  text, text, integer, date, double precision, double precision, double precision, text, integer, integer
);

create or replace function public.search_activities(
  p_query text default null, p_category_slug text default null,
  p_age_months integer default null, p_date date default null,
  p_lat double precision default null, p_lng double precision default null,
  p_radius_km double precision default null, p_sort text default 'popular',
  p_limit integer default 24, p_offset integer default 0
)
returns table(id uuid, slug text, title text, category_slug text, category_name text,
  age_min_months integer, age_max_months integer, price numeric, image_urls text[],
  latitude double precision, longitude double precision, rating_avg numeric,
  rating_count integer, popularity integer, next_session_at timestamptz,
  dist_km double precision, boosted boolean, provider_id uuid, provider_name text,
  address text, region text, duration_mins integer, instant_book boolean,
  image_source text, cover_image_url text,
  provider_logo_url text, provider_cover_image_url text, provider_gallery_urls text[])
language sql stable
as $function$
  select
    a.id, a.slug, a.title,
    c.slug, c.name,
    a.age_min_months, a.age_max_months,
    a.price, a.image_urls,
    coalesce(a.latitude,  p.latitude),
    coalesce(a.longitude, p.longitude),
    a.rating_avg, a.rating_count, a.popularity,
    nxt.starts_at,
    case when p_lat is not null and coalesce(a.latitude, p.latitude) is not null
         then public.distance_km(p_lat, p_lng, coalesce(a.latitude, p.latitude), coalesce(a.longitude, p.longitude)) end,
    (a.boosted_until is not null and a.boosted_until > now()) as boosted,
    a.provider_id,
    coalesce(p.business_name, a.provider_name),
    coalesce(a.address, p.address),
    coalesce(a.region, p.region),
    coalesce(
      round(extract(epoch from (nxt.ends_at - nxt.starts_at)) / 60)::int,
      dur.mins
    ),
    (a.external_booking_url is null) as instant_book,
    a.image_source, a.cover_image_url,
    p.logo_url, p.cover_image_url, p.gallery_urls
  from public.activities a
  join public.activity_categories c on c.id = a.category_id
  left join public.providers p on p.id = a.provider_id
  left join lateral (
    select s.starts_at, s.ends_at
    from public.activity_sessions s
    where s.activity_id = a.id and s.starts_at > now()
    order by s.starts_at
    limit 1
  ) nxt on true
  left join lateral (
    select round(extract(epoch from (s.ends_at - s.starts_at)) / 60)::int as mins
    from public.activity_sessions s
    where s.activity_id = a.id and s.ends_at is not null
    order by s.starts_at desc
    limit 1
  ) dur on true
  where a.is_published
    and coalesce(p.status, 'active') = 'active'
    and (p_query is null
         or a.search_tsv @@ websearch_to_tsquery('english', p_query)
         or to_tsvector('english', concat_ws(' ',
              coalesce(p.business_name, a.provider_name),
              coalesce(a.address, p.address),
              c.name
            )) @@ websearch_to_tsquery('english', p_query))
    and (p_category_slug is null or c.slug = p_category_slug)
    and (p_age_months is null
         or p_age_months between a.age_min_months and a.age_max_months)
    and (p_date is null or exists (
          select 1 from public.activity_sessions s
          where s.activity_id = a.id
            and (s.starts_at at time zone 'Asia/Singapore')::date = p_date))
    and (p_radius_km is null or p_lat is null or coalesce(a.latitude, p.latitude) is null
         or public.distance_km(p_lat, p_lng, coalesce(a.latitude, p.latitude), coalesce(a.longitude, p.longitude)) <= p_radius_km)
  order by
    case when p_sort = 'distance' and p_lat is not null and coalesce(a.latitude, p.latitude) is not null
         then public.distance_km(p_lat, p_lng, coalesce(a.latitude, p.latitude), coalesce(a.longitude, p.longitude))
    end asc nulls last,
    case when p_sort = 'rating' then a.rating_avg end desc nulls last,
    (a.external_booking_url is null) desc,
    (a.boosted_until is not null and a.boosted_until > now()) desc,
    a.popularity desc,
    a.created_at desc
  limit p_limit offset p_offset;
$function$;

notify pgrst, 'reload schema';

commit;
