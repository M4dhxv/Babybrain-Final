-- 00258_single_location_day_prices_on_activity.sql
--
-- Venue variability is going away (client, 2026-10-26): an activity has ONE venue, and a session
-- cannot be moved to a different one. This is step 1 of 2, and it only ADDS and re-points, so it is safe
-- before, during or after the apps that stop offering venues:
--
--   * Weekday/weekend prices move from the per-venue table (activity_locations.day_prices, 00250) onto
--     the activity itself: activities.day_prices. Same rule as 00250 (see effective_session_price):
--         the activity's weekday price  >  the session's own price  >  the activity's price
--     Production has no weekday prices in use, so nothing needs carrying over there; any that exist
--     on a primary venue row are copied across below.
--   * session_price(), upcoming_activity_sessions(), matching_activities() and search_activities() no
--     longer read activity_locations, so step 2 can drop that table. Their arguments and every output
--     column are unchanged. location_count is always 1 and venues is the activity's own venue, so an
--     older parent app opened before the change shows exactly what it did for a one-venue activity.
--   * activity_sessions.location_id is NOT touched: the sessions that already have their own venue keep
--     it as history (past bookings, emails and calendar files still show where they ran).
--
-- Step 2 (a later migration, once the new apps are live) drops the venue table, its triggers and the
-- session-venue sync from 00254.
--
-- Idempotent.

begin;

-- 1. Weekday prices on the activity.
alter table public.activities
  add column if not exists day_prices jsonb not null default '{}'::jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'activities_day_prices_valid') then
    alter table public.activities
      add constraint activities_day_prices_valid check (public.valid_day_prices(day_prices));
  end if;
end $$;

comment on column public.activities.day_prices is
  'Weekday prices: {"0".."6": price}, 0 = Sunday, Singapore time. Beats a price set on a single session, which beats activities.price.';

-- Carry across any weekday prices a vendor set on the primary venue (none on production).
update public.activities a
   set day_prices = al.day_prices
  from public.activity_locations al
 where al.activity_id = a.id
   and al.location_id = a.location_id
   and al.day_prices <> '{}'::jsonb
   and a.day_prices = '{}'::jsonb;

-- 2. The one place a session's price is decided (the booking and waitlist triggers and the checkout
--    routes call it).
create or replace function public.session_price(p_session uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select public.effective_session_price(s.price, null::numeric, a.price, a.day_prices, s.starts_at)
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  where s.id = p_session;
$$;

-- 3. upcoming_activity_sessions: same arguments and columns (00250), price from the activity's weekday prices.
create or replace function public.upcoming_activity_sessions(p_activity_id uuid, p_limit int default 14)
returns table (
  id uuid, activity_id uuid, starts_at timestamptz, ends_at timestamptz,
  capacity int, location_id uuid, price numeric, status text, bookings_paused boolean,
  teacher_name text, studio text, wix_slot_key text, wix_remaining_capacity int,
  created_at timestamptz, allow_cancellation boolean, cancellation_cutoff_hours int,
  cancellation_refund_mode text, allow_rescheduling boolean, reschedule_cutoff_hours int,
  booking_cutoff_minutes int, wix_event_id uuid, wix_day date
)
language sql
security definer
stable
set search_path to 'public'
as $function$
  with eligible as (
    select
      s.*,
      a.price as activity_price,
      a.day_prices as activity_day_prices,
      a.location_id as activity_location_id,
      dense_rank() over (order by (s.starts_at at time zone 'Asia/Singapore')::date) as day_rank
    from public.activity_sessions s
    join public.activities a on a.id = s.activity_id
    where s.activity_id = p_activity_id
      and s.wix_slot_key is null
      and s.bookings_paused = false
      and s.status is distinct from 'cancelled'
      and s.starts_at >= now()
  )
  select
    s.id, s.activity_id, s.starts_at, s.ends_at,
    case when s.capacity is null then null
         else greatest(0, s.capacity - coalesce(b.taken, 0))
    end as capacity,
    s.location_id,
    public.effective_session_price(s.price, null::numeric, s.activity_price, s.activity_day_prices, s.starts_at) as price,
    s.status, s.bookings_paused,
    s.teacher_name, s.studio, s.wix_slot_key, s.wix_remaining_capacity,
    s.created_at, s.allow_cancellation, s.cancellation_cutoff_hours,
    s.cancellation_refund_mode, s.allow_rescheduling, s.reschedule_cutoff_hours,
    s.booking_cutoff_minutes, s.wix_event_id, s.wix_day
  from eligible s
  left join lateral (
    select count(*) as taken
    from public.bookings b
    where b.session_id = s.id
      and b.status in ('pending', 'confirmed', 'completed')
  ) b on true
  where s.day_rank <= greatest(1, coalesce(p_limit, 14))
  order by s.starts_at;
$function$;

revoke all on function public.upcoming_activity_sessions(uuid, int) from public;
grant execute on function public.upcoming_activity_sessions(uuid, int) to anon, authenticated;

-- 4. matching_activities (00250's function, same signature and columns): the venue set is the
--    activity's own venue; the price range is the activity's price and weekday prices.
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

-- 5. search_activities (00257's function, same signature and columns, terms filter kept).
CREATE OR REPLACE FUNCTION public.search_activities(p_query text DEFAULT NULL::text, p_category_slug text DEFAULT NULL::text, p_age_months integer DEFAULT NULL::integer, p_date date DEFAULT NULL::date, p_lat double precision DEFAULT NULL::double precision, p_lng double precision DEFAULT NULL::double precision, p_radius_km double precision DEFAULT NULL::double precision, p_sort text DEFAULT 'popular'::text, p_limit integer DEFAULT 24, p_offset integer DEFAULT 0, p_categories text[] DEFAULT NULL::text[], p_age_min_months integer DEFAULT NULL::integer, p_age_max_months integer DEFAULT NULL::integer, p_regions text[] DEFAULT NULL::text[], p_max_price numeric DEFAULT NULL::numeric, p_date_from date DEFAULT NULL::date, p_date_to date DEFAULT NULL::date, p_time_min integer DEFAULT NULL::integer, p_time_max integer DEFAULT NULL::integer, p_region_order text[] DEFAULT NULL::text[], p_terms_only boolean DEFAULT NULL::boolean)
 RETURNS TABLE(id uuid, slug text, title text, category_slug text, category_name text, age_min_months integer, age_max_months integer, price numeric, image_urls text[], latitude double precision, longitude double precision, rating_avg numeric, rating_count integer, popularity integer, next_session_at timestamp with time zone, dist_km double precision, boosted boolean, provider_id uuid, provider_name text, address text, region text, duration_mins integer, instant_book boolean, image_source text, cover_image_url text, provider_logo_url text, provider_cover_image_url text, provider_gallery_urls text[], is_course boolean, run_starts_at timestamp with time zone, run_ends_at timestamp with time zone, category_2_slug text, category_2_name text, areas text[], venues jsonb, total_count bigint, is_custom_location boolean, custom_location_label text, price_from numeric, price_to numeric, location_count integer)
 LANGUAGE sql
 STABLE
AS $function$
  with m as (
    select *
    from public.matching_activities(
      p_query := p_query, p_category_slug := p_category_slug, p_categories := p_categories,
      p_age_months := p_age_months, p_age_min_months := p_age_min_months, p_age_max_months := p_age_max_months,
      p_date := p_date, p_date_from := p_date_from, p_date_to := p_date_to,
      p_time_min := p_time_min, p_time_max := p_time_max,
      p_regions := p_regions, p_max_price := p_max_price,
      p_lat := p_lat, p_lng := p_lng, p_radius_km := p_radius_km
    )
  ),
  -- Price range from the activity's own price and weekday prices only (same reasoning as
  -- matching_activities' prc: no session scan on the catalogue path). location_count is always 1
  -- now (an activity has one venue); the column stays so a parent app opened before this change keeps working.
  r as (
    select m.*, prc.lo as price_from, prc.hi as price_to, 1::int as location_count
    from m
    left join lateral (
      select min(z.v) as lo, max(z.v) as hi
      from (
        select m.price as v
        union all
        select (d.value #>> '{}')::numeric
        from public.activities aa, jsonb_each(aa.day_prices) d
        where aa.id = m.id
      ) z
    ) prc on true
  )
  select
    id, slug, title, category_slug, category_name,
    age_min_months, age_max_months, price, image_urls,
    latitude, longitude, rating_avg, rating_count, popularity, next_session_at,
    dist_km, boosted, provider_id, provider_name, address, region, duration_mins, instant_book,
    image_source, cover_image_url, provider_logo_url, provider_cover_image_url, provider_gallery_urls,
    is_course, run_starts_at, run_ends_at, category_2_slug, category_2_name,
    areas, venues,
    count(*) over() as total_count,
    is_custom_location,
    custom_location_label,
    price_from,
    price_to,
    location_count
  from r
  -- 00244: the Explore Terms filter - only activities with a term open.
  where p_terms_only is not true
     or id in (select tt.activity_id from public.activities_with_live_terms() tt)
  order by
    text_hit desc,
    case when p_sort = 'soonest' then next_session_at end asc nulls last,
    case when p_sort = 'distance' and p_lat is not null and p_region_order is not null
         then (select min(array_position(p_region_order, rr)) from unnest(areas) rr) end asc nulls last,
    case when p_sort = 'distance' and p_lat is not null
         then coalesce(
                (select min(public.distance_km(p_lat, p_lng, (v->>'lat')::float8, (v->>'lng')::float8))
                   from jsonb_array_elements(venues) v),
                dist_km) end asc nulls last,
    case when p_sort = 'rating' then rating_avg end desc nulls last,
    case when p_sort = 'price_asc' then coalesce(price_from, price) end asc nulls last,
    case when p_sort = 'price_desc' then coalesce(price_from, price) end desc nulls last,
    instant_book desc,
    boosted desc,
    popularity desc,
    created_at desc,
    id
  limit p_limit offset p_offset;
$function$
;

notify pgrst, 'reload schema';

commit;
