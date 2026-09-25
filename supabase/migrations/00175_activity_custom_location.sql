-- Vendors never enter a region today — it's silently derived from postal
-- code/lat-lng (sg_region(), set_activity_region(), see 00032/00095/00096).
-- That's fine for a fixed venue, but a private session held at the
-- *customer's* home has no real region of its own: it currently inherits
-- whatever region the vendor's own business address geocodes to, so a parent
-- filtering Explore by a different region never sees it even though the
-- vendor would actually travel there.
--
-- is_custom_location is a new, purely opt-in per-activity flag (mirrors the
-- existing image_source: 'profile' | 'custom' opt-in in ActivitiesPage.tsx).
-- It deliberately does NOT touch `region` itself — every existing consumer
-- of region/lat-lng (map pins, distance sort) keeps working unchanged, and
-- every existing vendor's auto-derived region is untouched. Flagged
-- activities just also match every region filter, everywhere region is used
-- as a hard filter or a scoring signal, and read to parents as
-- custom_location_label (or a generic "Custom" fallback) plus an
-- "as defined by you" note instead of a misleading fixed region (see the
-- parent frontend changes alongside this migration).

begin;

alter table public.activities
  add column if not exists is_custom_location boolean not null default false,
  add column if not exists custom_location_label text;

-- 1. matching_activities (00166) — add is_custom_location passthrough, and
--    let it satisfy the area filter regardless of which region(s) a parent
--    picked (or none).
drop function if exists public.matching_activities(
  text, text, text[], integer, integer, integer, date, date, date, integer, integer,
  text[], numeric, double precision, double precision, double precision
);

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
    -- A custom-location activity (private session at the customer's own
    -- home) has no fixed region of its own, so it satisfies any area
    -- filter rather than being silently excluded from every region but
    -- whichever one its unused address happens to geocode to.
    and (p_regions is null or x.areas && p_regions or x.is_custom_location)
    and x.price_ok
    and x.radius_ok
    and x.datetime_ok;
$function$;

grant execute on function public.matching_activities(
  text, text, text[], integer, integer, integer, date, date, date, integer, integer,
  text[], numeric, double precision, double precision, double precision
) to anon, authenticated, service_role;

-- 2. search_activities (00173) — passthrough is_custom_location, no ordering change.
drop function if exists public.search_activities(
  text, text, integer, date, double precision, double precision, double precision, text, integer, integer,
  text[], integer, integer, text[], numeric, date, date, integer, integer
);

create or replace function public.search_activities(
  p_query text default null, p_category_slug text default null,
  p_age_months integer default null, p_date date default null,
  p_lat double precision default null, p_lng double precision default null,
  p_radius_km double precision default null, p_sort text default 'popular',
  p_limit integer default 24, p_offset integer default 0,
  p_categories text[] default null, p_age_min_months integer default null, p_age_max_months integer default null,
  p_regions text[] default null, p_max_price numeric default null,
  p_date_from date default null, p_date_to date default null,
  p_time_min integer default null, p_time_max integer default null
)
returns table(id uuid, slug text, title text, category_slug text, category_name text,
  age_min_months integer, age_max_months integer, price numeric, image_urls text[],
  latitude double precision, longitude double precision, rating_avg numeric,
  rating_count integer, popularity integer, next_session_at timestamptz,
  dist_km double precision, boosted boolean, provider_id uuid, provider_name text,
  address text, region text, duration_mins integer, instant_book boolean,
  image_source text, cover_image_url text,
  provider_logo_url text, provider_cover_image_url text, provider_gallery_urls text[],
  is_course boolean, run_starts_at timestamptz, run_ends_at timestamptz,
  category_2_slug text, category_2_name text,
  areas text[], venues jsonb, total_count bigint, is_custom_location boolean, custom_location_label text)
language sql stable
as $function$
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
    custom_location_label
  from m
  order by
    text_hit desc,
    case when p_sort = 'distance' and p_lat is not null and latitude is not null
         then dist_km end asc nulls last,
    case when p_sort = 'rating' then rating_avg end desc nulls last,
    case when p_sort = 'price_asc' then price end asc nulls last,
    case when p_sort = 'price_desc' then price end desc nulls last,
    instant_book desc,
    boosted desc,
    popularity desc,
    created_at desc
  limit p_limit offset p_offset;
$function$;

grant execute on function public.search_activities(
  text, text, integer, date, double precision, double precision, double precision, text, integer, integer,
  text[], integer, integer, text[], numeric, date, date, integer, integer
) to anon, authenticated, service_role;

-- 3. compute_recommendations_for_child (00171) — a custom-location activity
--    always earns the "explicit region match" bonus instead of falling
--    through to (irrelevant, since it isn't really at that address) distance
--    scoring.
create or replace function public.compute_recommendations_for_child(p_child_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_child  public.children%rowtype;
  v_parent public.parent_profiles%rowtype;
  v_prefs  public.user_preferences%rowtype;
  v_age    int;
  v_interests text[];
begin
  select * into v_child from public.children where id = p_child_id;
  if not found then return; end if;

  select * into v_parent from public.parent_profiles where id = v_child.parent_id;
  select * into v_prefs from public.user_preferences where user_id = v_child.parent_id;

  v_age := extract(year from age(now(), v_child.date_of_birth)) * 12
         + extract(month from age(now(), v_child.date_of_birth));
  v_interests := coalesce(v_child.interests, '{}');

  delete from public.user_recommendations where child_id = p_child_id;

  insert into public.user_recommendations (child_id, activity_id, score, reasons)
  select
    p_child_id, s.id, s.age_pts + s.interest_pts + s.location_pts + s.budget_pts + s.schedule_pts,
    array_remove(array[
      case when s.age_pts = 30     then 'Matches ' || v_child.name || '''s age' end,
      case when s.interest_pts > 0 then 'Matches ' || v_child.name || '''s interests' end,
      case when s.location_pts >= 12 then 'Near your location' end,
      case when s.budget_pts = 10  then 'Within your budget' end,
      case when s.schedule_pts > 0 then 'Fits your preferred schedule' end
    ], null)
  from (
    select
      a.id,
      case when v_age between a.age_min_months and a.age_max_months
           then 30 else 15 end as age_pts,
      case when c.slug = any (v_interests) or a.tags && v_interests
           then 30 else 0 end as interest_pts,
      case
        when a.is_custom_location then 20
        when coalesce(v_prefs.preferred_regions, '{}') <> '{}' then
          case when coalesce(a.region, p.region) = any (v_prefs.preferred_regions)
               then 20 else 0 end
        when v_parent.latitude is null or a.latitude is null then 5
        when public.distance_km(v_parent.latitude, v_parent.longitude,
                                a.latitude, a.longitude) <= 3  then 20
        when public.distance_km(v_parent.latitude, v_parent.longitude,
                                a.latitude, a.longitude) <= 7  then 12
        when public.distance_km(v_parent.latitude, v_parent.longitude,
                                a.latitude, a.longitude) <= 15 then 5
        else 0
      end as location_pts,
      case
        when a.price is null or v_prefs.budget_max is null then 5
        when a.price <= v_prefs.budget_max then 10
        else 0
      end as budget_pts,
      case when exists (
        select 1 from public.activity_sessions s
        where s.activity_id = a.id
          and s.starts_at > now()
          and (coalesce(v_prefs.preferred_days, '{}') = '{}'
               or lower(trim(to_char(s.starts_at at time zone 'Asia/Singapore', 'dy')))
                  = any (v_prefs.preferred_days))
          and (coalesce(v_prefs.preferred_times, '{}') = '{}'
               or public.time_of_day(s.starts_at) = any (v_prefs.preferred_times))
      ) then 10 else 0 end as schedule_pts
    from public.activities a
    join public.activity_categories c on c.id = a.category_id
    left join public.providers p on p.id = a.provider_id
    where a.is_published
      and v_age between a.age_min_months - 3 and a.age_max_months + 3
  ) s
  where s.age_pts + s.interest_pts + s.location_pts + s.budget_pts + s.schedule_pts >= 30
  order by s.age_pts + s.interest_pts + s.location_pts + s.budget_pts + s.schedule_pts desc
  limit 20;
end;
$$;

-- 4. suggested_activities_for_parent (00171) — same hard-filter bypass so a
--    custom-location activity isn't silently dropped from the digest either.
create or replace function public.suggested_activities_for_parent(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with prefs as (
    select coalesce(preferred_regions, '{}') as regions
    from public.user_preferences
    where user_id = p_user_id
  ),
  candidates as (
    select
      a.id as activity_id,
      a.slug,
      s.id as session_id,
      s.starts_at,
      s.capacity,
      max(ur.score) as score
    from public.user_recommendations ur
    join public.children c on c.id = ur.child_id and c.parent_id = p_user_id
    join public.activities a on a.id = ur.activity_id and a.is_published
    left join public.providers p on p.id = a.provider_id
    join public.activity_sessions s on s.activity_id = a.id
      and s.starts_at between now() and now() + interval '7 days'
    cross join prefs
    where (prefs.regions = '{}' or coalesce(a.region, p.region) = any (prefs.regions) or a.is_custom_location)
      and not exists (
        select 1 from public.bookings b
        where b.session_id = s.id and b.user_id = p_user_id and b.status <> 'cancelled'
      )
    group by a.id, a.slug, s.id, s.starts_at, s.capacity
  ),
  open_seats as (
    select c.*
    from candidates c
    where c.capacity is null
      or c.capacity > (
        select count(*) from public.bookings b
        where b.session_id = c.session_id and b.status in ('confirmed', 'pending')
      )
  ),
  best_per_activity as (
    select distinct on (activity_id) activity_id, slug, session_id, starts_at, score
    from open_seats
    order by activity_id, score desc, starts_at asc
  ),
  top5 as (
    select * from best_per_activity
    order by score desc, starts_at asc
    limit 5
  )
  select coalesce(
    jsonb_agg(
      public.session_email_details(session_id) || jsonb_build_object('url', '/activity?slug=' || slug)
      order by score desc, starts_at asc
    ),
    '[]'::jsonb
  )
  from top5;
$$;

notify pgrst, 'reload schema';

commit;
