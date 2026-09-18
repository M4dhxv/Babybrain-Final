-- 00145_whole_day_duration.sql
--
-- Follow-up to 00144, which nulled any duration over 24 hours so a multi-day
-- camp stopped showing "72h". That hid a fact worth showing: a camp Wix sends as
-- one midnight-to-midnight occurrence runs a whole number of days, and "3 days"
-- is exactly what a parent wants to know.
--
-- duration_mins now passes through when the occurrence is EITHER a normal class
-- length (24 hours or less) OR an exact multiple of 24 hours (2 days = 2880,
-- 3 days = 4320, …). The app turns the latter into "N days". Anything else over
-- a day (say 40 hours, Fri evening to Sun morning) is still NULL: it is a span,
-- not something anyone attends for, and reading it as hours or as days would
-- both mislead.
--
-- The fallback (latest timed session) also skips the whole-run bookkeeping row
-- ('wixcourse:…'): it spans first→last session, so for an activity with no
-- other timed session it made the card claim the length of the entire run.
--
-- Return columns are unchanged from 00144, so create or replace updates the
-- body in place. Idempotent.

begin;

-- The function below carries `set pg_trgm.word_similarity_threshold`. Postgres
-- lets a non-superuser set an extension's setting only once that extension's
-- library is loaded in the session, else "permission denied to set parameter".
-- 00131 got that for free from creating its trigram indexes; on a re-run those
-- already exist and load nothing, so use the operator once to load it here.
select 'a'::text <% 'a'::text;

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
  provider_logo_url text, provider_cover_image_url text, provider_gallery_urls text[],
  is_course boolean, run_starts_at timestamptz, run_ends_at timestamptz)
language sql stable
set pg_trgm.word_similarity_threshold = 0.45
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
      case when nxt.ends_at - nxt.starts_at <= interval '24 hours'
                or extract(epoch from (nxt.ends_at - nxt.starts_at)) % 86400 = 0
           then round(extract(epoch from (nxt.ends_at - nxt.starts_at)) / 60)::int end,
      dur.mins
    ),
    (a.external_booking_url is null) as instant_book,
    a.image_source, a.cover_image_url,
    p.logo_url, p.cover_image_url, p.gallery_urls,
    coalesce(a.wix_service_type = 'COURSE', false),
    run.starts_at, run.ends_at
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
      and (s.wix_slot_key is null or s.wix_slot_key not like 'wixcourse:%')
      and (s.ends_at - s.starts_at <= interval '24 hours'
           or extract(epoch from (s.ends_at - s.starts_at)) % 86400 = 0)
    order by s.starts_at desc
    limit 1
  ) dur on true
  left join lateral (
    select s.starts_at, s.ends_at
    from public.activity_sessions s
    where a.wix_service_type = 'COURSE'
      and s.activity_id = a.id
      and (s.wix_slot_key is null or s.wix_slot_key not like 'wixcourse:%')
      and coalesce(s.ends_at, s.starts_at) > now()
    order by s.starts_at
    limit 1
  ) run on true
  where a.is_published
    and coalesce(p.status, 'active') = 'active'
    and (p_query is null
         or a.search_tsv @@ websearch_to_tsquery('english', p_query)
         or to_tsvector('english', concat_ws(' ',
              coalesce(p.business_name, a.provider_name),
              coalesce(a.address, p.address),
              c.name
            )) @@ websearch_to_tsquery('english', p_query)
         or p_query <% a.title
         or p_query <% coalesce(p.business_name, a.provider_name)
         or p_query <% c.name)
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
    -- An exact/near full-text hit should still outrank a fuzzy-only one, so a
    -- correctly-spelled query isn't reordered by this fallback.
    case when p_query is not null and (
           a.search_tsv @@ websearch_to_tsquery('english', p_query)
           or to_tsvector('english', concat_ws(' ',
                coalesce(p.business_name, a.provider_name),
                coalesce(a.address, p.address),
                c.name
              )) @@ websearch_to_tsquery('english', p_query)
         ) then 0 else 1 end asc,
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
