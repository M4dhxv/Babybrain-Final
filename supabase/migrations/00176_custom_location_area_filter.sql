-- 00175 made a custom-location activity (a private session at the customer's
-- own home) satisfy every Explore area filter, since it has no fixed region
-- of its own. But there was no way to explicitly ask for "just the private/
-- at-home ones" — and no count for them in the Area filter sheet at all,
-- since search_activity_facets' 'area' facet only ever unnests each
-- activity's own areas[], which a custom-location activity doesn't carry.
--
-- This adds a dedicated 'custom' pseudo-region: picking it (alone or with
-- other areas — either way) narrows the result to ONLY custom-location
-- activities, while every other area selection keeps including them as
-- before (00175's behaviour, unchanged). And search_activity_facets now
-- reports a 'custom' key under the 'area' facet so the filter sheet can show
-- its own count, same as Central/East/etc.

begin;

create or replace function public.matching_activities(
  p_query text default null,
  p_category_slug text default null, p_categories text[] default null,
  p_age_months integer default null, p_age_min_months integer default null, p_age_max_months integer default null,
  p_date date default null, p_date_from date default null, p_date_to date default null,
  p_time_min integer default null, p_time_max integer default null,
  p_regions text[] default null, p_max_price numeric default null,
  p_lat double precision default null, p_lng double precision default null, p_radius_km double precision default null
)
returns table(
  id uuid, slug text, title text,
  category_slug text, category_name text, category_2_slug text, category_2_name text,
  age_min_months integer, age_max_months integer, price numeric, image_urls text[],
  latitude double precision, longitude double precision,
  rating_avg numeric, rating_count integer, popularity integer,
  next_session_at timestamptz,
  dist_km double precision, boosted boolean, provider_id uuid, provider_name text,
  address text, region text, duration_mins integer, instant_book boolean,
  image_source text, cover_image_url text,
  provider_logo_url text, provider_cover_image_url text, provider_gallery_urls text[],
  is_course boolean, run_starts_at timestamptz, run_ends_at timestamptz,
  areas text[], venues jsonb,
  created_at timestamptz, text_hit boolean, is_custom_location boolean, custom_location_label text
)
language sql stable
as $function$
  with prm as (
    select
      coalesce(p_categories, case when p_category_slug is not null then array[p_category_slug] end) as categories,
      coalesce(p_age_min_months, p_age_months) as age_min,
      coalesce(p_age_max_months, p_age_months) as age_max,
      coalesce(p_date_from, p_date) as date_from,
      coalesce(p_date_to, p_date) as date_to
  ),
  x as (
    select
      a.id, a.slug, a.title,
      c.slug as category_slug, c.name as category_name,
      c2.slug as category_2_slug, c2.name as category_2_name,
      a.age_min_months, a.age_max_months,
      a.price, a.image_urls,
      coalesce(a.latitude, p.latitude) as latitude,
      coalesce(a.longitude, p.longitude) as longitude,
      a.rating_avg, a.rating_count, a.popularity,
      coalesce(matchsess.starts_at, nxt.starts_at) as next_session_at,
      case when p_lat is not null and coalesce(a.latitude, p.latitude) is not null
           then public.distance_km(p_lat, p_lng, coalesce(a.latitude, p.latitude), coalesce(a.longitude, p.longitude)) end as dist_km,
      (a.boosted_until is not null and a.boosted_until > now()) as boosted,
      a.provider_id,
      coalesce(p.business_name, a.provider_name) as provider_name,
      coalesce(a.address, p.address) as address,
      coalesce(a.region, p.region) as region,
      coalesce(
        case when nxt.ends_at - nxt.starts_at <= interval '24 hours'
                  or extract(epoch from (nxt.ends_at - nxt.starts_at)) % 86400 = 0
             then round(extract(epoch from (nxt.ends_at - nxt.starts_at)) / 60)::int end,
        dur.mins
      ) as duration_mins,
      (a.external_booking_url is null) as instant_book,
      a.image_source, a.cover_image_url,
      p.logo_url as provider_logo_url, p.cover_image_url as provider_cover_image_url, p.gallery_urls as provider_gallery_urls,
      coalesce(a.wix_service_type = 'COURSE', false) as is_course,
      run.starts_at as run_starts_at, run.ends_at as run_ends_at,
      coalesce(ownv.own_regions, array_remove(array[a.region], null::text)) as areas,
      coalesce(
        ownv.own_venues,
        case
          when coalesce(a.latitude, p.latitude) is not null and coalesce(a.longitude, p.longitude) is not null
            then jsonb_build_array(jsonb_build_object(
              'name', coalesce(p.business_name, a.provider_name, a.title),
              'lat', coalesce(a.latitude, p.latitude), 'lng', coalesce(a.longitude, p.longitude),
              'region', coalesce(a.region, p.region)))
          when primloc.latitude is not null
            then jsonb_build_array(jsonb_build_object(
              'name', primloc.name, 'lat', primloc.latitude, 'lng', primloc.longitude, 'region', primloc.region))
          else '[]'::jsonb
        end
      ) as venues,
      a.created_at,
      a.is_published,
      a.is_custom_location,
      a.custom_location_label,
      coalesce(p.status, 'active') = 'active' as provider_active,
      (p_query is null
        or a.search_tsv @@ websearch_to_tsquery('english', p_query)
        or to_tsvector('english', concat_ws(' ',
             coalesce(p.business_name, a.provider_name), coalesce(a.address, p.address), c.name
           )) @@ websearch_to_tsquery('english', p_query)
        or word_similarity(p_query, a.title) >= 0.45
        or word_similarity(p_query, coalesce(p.business_name, a.provider_name)) >= 0.45
        or word_similarity(p_query, c.name) >= 0.45) as query_ok,
      (p_query is not null and (
        a.search_tsv @@ websearch_to_tsquery('english', p_query)
        or to_tsvector('english', concat_ws(' ',
             coalesce(p.business_name, a.provider_name), coalesce(a.address, p.address), c.name
           )) @@ websearch_to_tsquery('english', p_query)
      )) as text_hit,
      (prm.categories is null or c.slug = any(prm.categories) or c2.slug = any(prm.categories)) as categories_ok,
      (prm.age_min is null or (a.age_min_months <= prm.age_max and a.age_max_months >= prm.age_min)) as age_ok,
      (p_max_price is null or a.price is null or a.price <= p_max_price) as price_ok,
      (p_radius_km is null or p_lat is null or coalesce(a.latitude, p.latitude) is null
        or public.distance_km(p_lat, p_lng, coalesce(a.latitude, p.latitude), coalesce(a.longitude, p.longitude)) <= p_radius_km) as radius_ok,
      (
        (prm.date_from is null and prm.date_to is null and p_time_min is null and p_time_max is null)
        or (
          coalesce(a.wix_service_type = 'COURSE', false) and run.starts_at is not null and run.ends_at is not null
          and (run.ends_at - run.starts_at > interval '24 hours'
               or ((run.starts_at at time zone 'Asia/Singapore')::time = '00:00'
                   and (run.ends_at at time zone 'Asia/Singapore')::time = '00:00'
                   and run.ends_at > run.starts_at))
          and (
            (prm.date_from is null and prm.date_to is null)
            or (
              (prm.date_from is null or run.ends_at > (prm.date_from::timestamp at time zone 'Asia/Singapore'))
              and (prm.date_to is null or run.starts_at < ((prm.date_to + 1)::timestamp at time zone 'Asia/Singapore'))
            )
          )
        )
        or (
          not coalesce(a.wix_service_type = 'COURSE', false)
          and matchsess.starts_at is not null
        )
      ) as datetime_ok
    from public.activities a
    cross join prm
    join public.activity_categories c on c.id = a.category_id
    left join public.activity_categories c2 on c2.id = a.secondary_category_id
    left join public.providers p on p.id = a.provider_id
    left join lateral (
      select s.starts_at, s.ends_at
      from public.activity_sessions s
      where s.activity_id = a.id and s.status <> 'cancelled' and s.starts_at > now()
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
    left join lateral (
      select
        array_agg(distinct pl.region) filter (where pl.region is not null) as own_regions,
        jsonb_agg(distinct jsonb_build_object('name', pl.name, 'lat', pl.latitude, 'lng', pl.longitude, 'region', pl.region))
          filter (where pl.latitude is not null and pl.longitude is not null) as own_venues
      from public.provider_locations pl
      where pl.id in (
        select a.location_id
        union
        select s2.location_id
        from public.activity_sessions s2
        where s2.activity_id = a.id and s2.location_id is not null
          and s2.status <> 'cancelled' and s2.starts_at > now()
      )
    ) ownv on true
    left join lateral (
      select pl2.name, pl2.latitude, pl2.longitude, pl2.region
      from public.provider_locations pl2
      where pl2.provider_id = a.provider_id and pl2.is_primary
      limit 1
    ) primloc on true
    left join lateral (
      select s3.starts_at
      from public.activity_sessions s3
      where s3.activity_id = a.id and s3.status <> 'cancelled' and s3.starts_at > now()
        and (prm.date_from is null or (s3.starts_at at time zone 'Asia/Singapore')::date >= prm.date_from)
        and (prm.date_to is null or (s3.starts_at at time zone 'Asia/Singapore')::date <= prm.date_to)
        and (p_time_min is null or extract(hour from s3.starts_at at time zone 'Asia/Singapore') >= p_time_min)
        and (p_time_max is null or extract(hour from s3.starts_at at time zone 'Asia/Singapore') <= p_time_max)
      order by s3.starts_at
      limit 1
    ) matchsess on true
  )
  select
    id, slug, title, category_slug, category_name, category_2_slug, category_2_name,
    age_min_months, age_max_months, price, image_urls, latitude, longitude,
    rating_avg, rating_count, popularity, next_session_at,
    dist_km, boosted, provider_id, provider_name, address, region, duration_mins, instant_book,
    image_source, cover_image_url, provider_logo_url, provider_cover_image_url, provider_gallery_urls,
    is_course, run_starts_at, run_ends_at, areas, venues, created_at, text_hit, is_custom_location, custom_location_label
  from x
  where x.is_published
    and x.provider_active
    and x.query_ok
    and x.categories_ok
    and x.age_ok
    and (
      case
        -- Explicitly asking for "Custom location" means only the
        -- private/at-home ones — not every area's activities plus them.
        when p_regions is not null and 'custom' = any(p_regions) then x.is_custom_location
        -- Otherwise a custom-location activity still satisfies any area
        -- filter (or none), same as 00175 — it has no fixed region of its
        -- own to be excluded by.
        else (p_regions is null or x.areas && p_regions or x.is_custom_location)
      end
    )
    and x.price_ok
    and x.radius_ok
    and x.datetime_ok;
$function$;

create or replace function public.search_activity_facets(
  p_query text default null,
  p_category_slug text default null, p_categories text[] default null,
  p_age_months integer default null, p_age_min_months integer default null, p_age_max_months integer default null,
  p_date date default null, p_date_from date default null, p_date_to date default null,
  p_time_min integer default null, p_time_max integer default null,
  p_regions text[] default null, p_max_price numeric default null,
  p_lat double precision default null, p_lng double precision default null, p_radius_km double precision default null
)
returns table(facet text, key text, cnt bigint)
language sql stable
as $function$
  select 'type', k, count(*)
  from public.matching_activities(
    p_query := p_query, p_category_slug := null, p_categories := null,
    p_age_months := p_age_months, p_age_min_months := p_age_min_months, p_age_max_months := p_age_max_months,
    p_date := p_date, p_date_from := p_date_from, p_date_to := p_date_to,
    p_time_min := p_time_min, p_time_max := p_time_max,
    p_regions := p_regions, p_max_price := p_max_price,
    p_lat := p_lat, p_lng := p_lng, p_radius_km := p_radius_km
  ) m
  cross join lateral unnest(array[m.category_slug, m.category_2_slug]) as k
  where k is not null
  group by k

  union all

  -- The five age bands are fixed and small — see AGE_BANDS in
  -- frontends/parent/src/App.tsx, which this must stay in sync with.
  select 'age', b.key, count(*)
  from public.matching_activities(
    p_query := p_query, p_category_slug := p_category_slug, p_categories := p_categories,
    p_age_months := null, p_age_min_months := null, p_age_max_months := null,
    p_date := p_date, p_date_from := p_date_from, p_date_to := p_date_to,
    p_time_min := p_time_min, p_time_max := p_time_max,
    p_regions := p_regions, p_max_price := p_max_price,
    p_lat := p_lat, p_lng := p_lng, p_radius_km := p_radius_km
  ) m
  cross join (values ('0-5', 0, 5), ('6-11', 6, 11), ('12-17', 12, 17), ('18-35', 18, 35), ('36+', 36, 132)) as b(key, min_m, max_m)
  where m.age_min_months <= b.max_m and m.age_max_months >= b.min_m
  group by b.key

  union all

  select 'area', r, count(*)
  from public.matching_activities(
    p_query := p_query, p_category_slug := p_category_slug, p_categories := p_categories,
    p_age_months := p_age_months, p_age_min_months := p_age_min_months, p_age_max_months := p_age_max_months,
    p_date := p_date, p_date_from := p_date_from, p_date_to := p_date_to,
    p_time_min := p_time_min, p_time_max := p_time_max,
    p_regions := null, p_max_price := p_max_price,
    p_lat := p_lat, p_lng := p_lng, p_radius_km := p_radius_km
  ) m
  cross join lateral unnest(m.areas) as r
  group by r

  union all

  -- A custom-location activity carries no entry in areas[], so it needs its
  -- own count here rather than being picked up by the unnest above.
  select 'area', 'custom', count(*)
  from public.matching_activities(
    p_query := p_query, p_category_slug := p_category_slug, p_categories := p_categories,
    p_age_months := p_age_months, p_age_min_months := p_age_min_months, p_age_max_months := p_age_max_months,
    p_date := p_date, p_date_from := p_date_from, p_date_to := p_date_to,
    p_time_min := p_time_min, p_time_max := p_time_max,
    p_regions := null, p_max_price := p_max_price,
    p_lat := p_lat, p_lng := p_lng, p_radius_km := p_radius_km
  ) m
  where m.is_custom_location
$function$;

grant execute on function public.search_activity_facets(
  text, text, text[], integer, integer, integer, date, date, date, integer, integer,
  text[], numeric, double precision, double precision, double precision
) to anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
