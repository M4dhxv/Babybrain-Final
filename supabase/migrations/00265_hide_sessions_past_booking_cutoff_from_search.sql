-- 00265_hide_sessions_past_booking_cutoff_from_search.sql
--
-- Issues sheet 28 Oct: "When a vendor sets a booking cut-off, activities within that window still display
-- on the listing but then parents aren't able to book - bad experience. Once the booking cut off has
-- passed, the activity shouldn't be displayed in the search."
--
-- matching_activities() (which search_activities() wraps) picked each card's next session, and the
-- session that satisfies a date / time filter, with only "starts in the future". A session that begins
-- inside its booking cut-off (session override, else the activity's, else 15 minutes: the same rule as
-- 00197's booking check) is shown on the card and matches the filter, yet cannot be booked. Both lookups now
-- skip such sessions, so the card shows the next session a parent can actually book and a date / time
-- filter no longer matches an activity on the strength of a closed session.
--
-- Same arguments and output columns as 00258; only the two session lookups change. Idempotent.

begin;

-- matching_activities as 00258 left it, with the two session lookups (nxt, matchsess) skipping sessions whose
-- booking cut-off has passed.
CREATE OR REPLACE FUNCTION public.matching_activities(p_query text DEFAULT NULL::text, p_category_slug text DEFAULT NULL::text, p_categories text[] DEFAULT NULL::text[], p_age_months integer DEFAULT NULL::integer, p_age_min_months integer DEFAULT NULL::integer, p_age_max_months integer DEFAULT NULL::integer, p_date date DEFAULT NULL::date, p_date_from date DEFAULT NULL::date, p_date_to date DEFAULT NULL::date, p_time_min integer DEFAULT NULL::integer, p_time_max integer DEFAULT NULL::integer, p_regions text[] DEFAULT NULL::text[], p_max_price numeric DEFAULT NULL::numeric, p_lat double precision DEFAULT NULL::double precision, p_lng double precision DEFAULT NULL::double precision, p_radius_km double precision DEFAULT NULL::double precision)
 RETURNS TABLE(id uuid, slug text, title text, category_slug text, category_name text, category_2_slug text, category_2_name text, age_min_months integer, age_max_months integer, price numeric, image_urls text[], latitude double precision, longitude double precision, rating_avg numeric, rating_count integer, popularity integer, next_session_at timestamp with time zone, dist_km double precision, boosted boolean, provider_id uuid, provider_name text, address text, region text, duration_mins integer, instant_book boolean, image_source text, cover_image_url text, provider_logo_url text, provider_cover_image_url text, provider_gallery_urls text[], is_course boolean, run_starts_at timestamp with time zone, run_ends_at timestamp with time zone, areas text[], venues jsonb, created_at timestamp with time zone, text_hit boolean, is_custom_location boolean, custom_location_label text)
 LANGUAGE plpgsql
 STABLE
 ROWS 200
 SET plan_cache_mode TO 'force_generic_plan'
AS $function$
#variable_conflict use_column
begin
  return query
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
      (
      (a.boosted_until is not null and a.boosted_until > now())
      -- 00191: Premium vendors get the same featured placement a Boost buys.
      or exists (
        select 1 from public.subscriptions sub
        where sub.provider_id = a.provider_id
          and sub.plan in ('pro', 'premium')
          and sub.status in ('active', 'trialing')
      )
    ) as boosted,
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
            and (
              a.location_id is null
              or (primloc.postal_code is not null
                  and primloc.postal_code is not distinct from (select pl3.postal_code from public.provider_locations pl3 where pl3.id = a.location_id))
            )
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
      (p_max_price is null or coalesce(prc.lo, a.price) is null or coalesce(prc.lo, a.price) <= p_max_price) as price_ok,
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
        -- 00265: a session whose booking window has closed can't be booked, so it is not "next".
        and s.starts_at > now() + make_interval(mins => coalesce(s.booking_cutoff_minutes, a.booking_cutoff_minutes, 15))
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
        array_agg(distinct v.region) filter (where v.region is not null) as own_regions,
        jsonb_agg(jsonb_build_object(
                    'id', v.id, 'name', v.name, 'lat', v.latitude, 'lng', v.longitude,
                    'region', v.region, 'address', v.address, 'primary', v.is_primary)
                  order by v.is_primary desc, v.pos, v.name)
          filter (where v.latitude is not null and v.longitude is not null) as own_venues
      from (
        -- One per place: a provider can hold two rows for the same venue
        -- (see 00223), which used to collapse because the objects were equal.
        select distinct on (pl.name, pl.latitude, pl.longitude)
          pl.id, pl.name, pl.latitude, pl.longitude, pl.region, pl.address,
          (pl.id = a.location_id) as is_primary,
          0 as pos
        from public.provider_locations pl
        where pl.id = a.location_id
        order by pl.name, pl.latitude, pl.longitude
      ) v
    ) ownv on true
    -- Cheapest and dearest price the activity can cost on any day: its own price and its weekday
    -- prices. Reads only the activity row, not sessions, so it adds no session scan to the catalogue query.
    left join lateral (
      select min(z.v) as lo, max(z.v) as hi
      from (
        select a.price as v
        union all
        select (d.value #>> '{}')::numeric
        from jsonb_each(a.day_prices) d
      ) z
    ) prc on true
    left join lateral (
      select pl2.name, pl2.latitude, pl2.longitude, pl2.region, pl2.postal_code
      from public.provider_locations pl2
      where pl2.provider_id = a.provider_id and pl2.is_primary
      limit 1
    ) primloc on true
    left join lateral (
      select s3.starts_at
      from public.activity_sessions s3
      where s3.activity_id = a.id and s3.status <> 'cancelled' and s3.starts_at > now()
        and s3.starts_at > now() + make_interval(mins => coalesce(s3.booking_cutoff_minutes, a.booking_cutoff_minutes, 15))
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
    and (p_regions is null or x.areas && p_regions or x.is_custom_location)
    and x.price_ok
    and x.radius_ok
    and x.datetime_ok;
end;
$function$;

notify pgrst, 'reload schema';

commit;
