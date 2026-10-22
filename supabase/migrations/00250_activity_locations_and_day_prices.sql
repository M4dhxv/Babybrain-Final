-- 00250_activity_locations_and_day_prices.sql
--
-- An activity can run at several of its provider's venues, and each venue can
-- have its own price, plus its own price for particular weekdays (a weekend
-- price is just Saturday + Sunday).
--
--  * activity_locations: one row per venue an activity runs at. The PRIMARY
--    venue is still activities.location_id; a trigger keeps a row for it, so
--    the portal code already deployed and the Wix sync (which only ever write
--    activities.location_id) keep working unchanged. Extra venues and every
--    venue's prices are new data that only the new portal writes.
--  * Prices are worked out when they are read, never copied into sessions, so a
--    weekday price reaches every session on that weekday — ones that already
--    exist and ones added later — and changing it later leaves nothing stale.
--    The rule (agreed with Aman 2026-10-22), for a session at venue L on day D:
--
--        L's price for D  >  the session's own price  >  L's price  >  activities.price
--
--    A session with no venue of its own is at the activity's primary venue.
--    Native activities only: the portal offers none of this on Wix-linked ones
--    (Wix Bookings checkout charges activities.price; Wix Events price is
--    display-only), so their rows carry no prices and the rule falls through.
--  * Packages are unchanged: a credit books a session whatever it costs.
--
-- Compatibility with the deployed apps (see 00247): every RPC keeps its
-- arguments and existing columns. search_activities gains trailing columns
-- (price_from, price_to, location_count) that older clients ignore;
-- upcoming_activity_sessions now returns the *effective* price in `price`
-- (what the booking page and checkout charge).
--
-- Idempotent.

begin;

-- =============================================================
-- 1. TABLE
-- =============================================================

-- {"0": 30, "6": 30}: keys are weekdays in Singapore time (0 = Sunday,
-- 6 = Saturday), values non-negative prices in SGD.
create or replace function public.valid_day_prices(p jsonb)
returns boolean
language sql
immutable
as $$
  select jsonb_typeof(p) = 'object'
     and not exists (
       select 1 from jsonb_each(p) e
       where e.key not in ('0', '1', '2', '3', '4', '5', '6')
          or jsonb_typeof(e.value) <> 'number'
          or (e.value #>> '{}')::numeric < 0
     );
$$;

create table if not exists public.activity_locations (
  activity_id uuid not null references public.activities (id) on delete cascade,
  location_id uuid not null references public.provider_locations (id) on delete cascade,
  -- Display order of the extra venues (the primary is activities.location_id).
  position    int not null default 0,
  -- NULL = the activity's own price.
  price       numeric(10, 2) check (price is null or price >= 0),
  day_prices  jsonb not null default '{}'::jsonb check (public.valid_day_prices(day_prices)),
  created_at  timestamptz not null default now(),
  primary key (activity_id, location_id)
);

create index if not exists activity_locations_location_idx on public.activity_locations (location_id);

comment on table public.activity_locations is
  'Venues an activity runs at, each with an optional own price and weekday prices. The primary venue is activities.location_id (kept in step by trigger).';
comment on column public.activity_locations.day_prices is
  'Weekday prices at this venue: {"0".."6": price}, 0 = Sunday, Singapore time. Beats every other price for a session on that day.';

-- A venue must belong to the activity's own provider.
create or replace function public.activity_location_same_provider()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1
    from public.activities a
    join public.provider_locations pl on pl.provider_id = a.provider_id
    where a.id = new.activity_id and pl.id = new.location_id
  ) then
    raise exception 'That location belongs to a different business' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.activity_location_same_provider() from public, anon, authenticated;

drop trigger if exists activity_locations_same_provider on public.activity_locations;
create trigger activity_locations_same_provider
  before insert or update of activity_id, location_id on public.activity_locations
  for each row execute function public.activity_location_same_provider();

-- Keep a row for activities.location_id, whoever sets it (old portal, Wix sync,
-- admin, the new portal). Moving the primary drops the old primary's row, which
-- is what the single-venue writers mean; the new portal rewrites the full set of
-- venues right after, so a venue it keeps comes straight back with its prices.
create or replace function public.sync_activity_primary_location()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    if new.location_id is not distinct from old.location_id then
      return null;
    end if;
    if old.location_id is not null then
      delete from public.activity_locations
      where activity_id = new.id and location_id = old.location_id;
    end if;
  end if;
  if new.location_id is not null
     and exists (select 1 from public.provider_locations pl
                 where pl.id = new.location_id and pl.provider_id = new.provider_id) then
    insert into public.activity_locations (activity_id, location_id, position)
    values (new.id, new.location_id, 0)
    on conflict (activity_id, location_id) do update set position = 0;
  end if;
  return null;
end;
$$;
revoke all on function public.sync_activity_primary_location() from public, anon, authenticated;

drop trigger if exists activities_sync_primary_location on public.activities;
create trigger activities_sync_primary_location
  after insert or update of location_id on public.activities
  for each row execute function public.sync_activity_primary_location();

-- Explore's cache stamp (00246) moves when venues or their prices change.
drop trigger if exists catalogue_version_activity_locations on public.activity_locations;
create trigger catalogue_version_activity_locations
  after insert or update or delete on public.activity_locations
  for each statement execute function public.bump_catalogue_version();

-- =============================================================
-- 2. BACKFILL: every activity's primary venue, plus each venue its upcoming
--    sessions already run at (00074 let a session name its own venue).
-- =============================================================
insert into public.activity_locations (activity_id, location_id, position)
select a.id, a.location_id, 0
from public.activities a
join public.provider_locations pl on pl.id = a.location_id and pl.provider_id = a.provider_id
on conflict do nothing;

insert into public.activity_locations (activity_id, location_id, position)
select v.activity_id, v.location_id, row_number() over (partition by v.activity_id order by v.first_at)
from (
  select s.activity_id, s.location_id, min(s.starts_at) as first_at
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  join public.provider_locations pl on pl.id = s.location_id and pl.provider_id = a.provider_id
  where s.location_id is not null
    and s.location_id is distinct from a.location_id
    and s.status <> 'cancelled'
    and s.starts_at > now()
  group by s.activity_id, s.location_id
) v
on conflict do nothing;

-- =============================================================
-- 3. RLS: readable wherever the activity is (published, or your own);
--    writable by the activity's managers. Admin tools use the service role.
-- =============================================================
alter table public.activity_locations enable row level security;

drop policy if exists "activity locations follow activity visibility" on public.activity_locations;
create policy "activity locations follow activity visibility" on public.activity_locations
  for select using (exists (select 1 from public.activities a where a.id = activity_id));

drop policy if exists "managers write activity locations" on public.activity_locations;
create policy "managers write activity locations" on public.activity_locations
  for all
  using (exists (select 1 from public.activities a
                 where a.id = activity_id and a.provider_id in (select user_manage_provider_ids())))
  with check (exists (select 1 from public.activities a
                      where a.id = activity_id and a.provider_id in (select user_manage_provider_ids())));

-- =============================================================
-- 4. PRICE RULE
-- =============================================================
create or replace function public.effective_session_price(
  p_session_price numeric, p_location_price numeric, p_activity_price numeric,
  p_day_prices jsonb, p_starts_at timestamptz
)
returns numeric
language sql
stable
as $$
  select coalesce(
    (p_day_prices ->> extract(dow from p_starts_at at time zone 'Asia/Singapore')::int::text)::numeric,
    p_session_price, p_location_price, p_activity_price
  );
$$;
revoke all on function public.effective_session_price(numeric, numeric, numeric, jsonb, timestamptz) from public, anon, authenticated;

-- The one place a session's price is decided: the booking and waitlist
-- triggers call it, and so do the checkout routes.
create or replace function public.session_price(p_session uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select public.effective_session_price(s.price, al.price, a.price, coalesce(al.day_prices, '{}'::jsonb), s.starts_at)
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  left join public.activity_locations al
    on al.activity_id = s.activity_id and al.location_id = coalesce(s.location_id, a.location_id)
  where s.id = p_session;
$$;

-- =============================================================
-- 5. upcoming_activity_sessions: same arguments and columns (00221), but
--    `price` is now the session's effective price, so the activity and booking
--    pages show what checkout will charge.
-- =============================================================
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
    public.effective_session_price(s.price, al.price, s.activity_price, coalesce(al.day_prices, '{}'::jsonb), s.starts_at) as price,
    s.status, s.bookings_paused,
    s.teacher_name, s.studio, s.wix_slot_key, s.wix_remaining_capacity,
    s.created_at, s.allow_cancellation, s.cancellation_cutoff_hours,
    s.cancellation_refund_mode, s.allow_rescheduling, s.reschedule_cutoff_hours,
    s.booking_cutoff_minutes, s.wix_event_id, s.wix_day
  from eligible s
  left join public.activity_locations al
    on al.activity_id = s.activity_id and al.location_id = coalesce(s.location_id, s.activity_location_id)
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

-- =============================================================
-- 6. matching_activities (00223's function, same signature and columns):
--    * the venue set includes activity_locations, each venue now carries its
--      id, address and whether it is the primary, primary first;
--    * the max-price filter matches on the cheapest price the activity has.
-- =============================================================
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
          coalesce(alp.position, 1000) as pos
        from public.provider_locations pl
        left join public.activity_locations alp on alp.activity_id = a.id and alp.location_id = pl.id
        where pl.id in (
          select a.location_id
          union
          select al.location_id from public.activity_locations al where al.activity_id = a.id
          union
          select s2.location_id
          from public.activity_sessions s2
          where s2.activity_id = a.id and s2.location_id is not null
            and s2.status <> 'cancelled' and s2.starts_at > now()
        )
        order by pl.name, pl.latitude, pl.longitude, (pl.id = a.location_id) desc, coalesce(alp.position, 1000)
      ) v
    ) ownv on true
    -- Cheapest and dearest price the activity can cost at any of its venues on
    -- any day. Reads only activity_locations (a handful of rows per activity),
    -- not sessions, so it adds no session scan to the catalogue query.
    left join lateral (
      select min(z.v) as lo, max(z.v) as hi
      from (
        select a.price as v
        union all
        select coalesce(al.price, a.price) from public.activity_locations al where al.activity_id = a.id
        union all
        select (d.value #>> '{}')::numeric
        from public.activity_locations al, jsonb_each(al.day_prices) d
        where al.activity_id = a.id
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

-- =============================================================
-- 7. search_activities: 00220's function plus three trailing columns for the
--    cards — price_from / price_to (the price range across venues and days)
--    and location_count — and price sorting by the cheapest price. Adding
--    output columns changes the return type, so it is dropped and recreated
--    with the same arguments and grants.
-- =============================================================
drop function if exists public.search_activities(text,text,integer,date,double precision,double precision,double precision,text,integer,integer,text[],integer,integer,text[],numeric,date,date,integer,integer,text[]);

CREATE OR REPLACE FUNCTION public.search_activities(p_query text DEFAULT NULL::text, p_category_slug text DEFAULT NULL::text, p_age_months integer DEFAULT NULL::integer, p_date date DEFAULT NULL::date, p_lat double precision DEFAULT NULL::double precision, p_lng double precision DEFAULT NULL::double precision, p_radius_km double precision DEFAULT NULL::double precision, p_sort text DEFAULT 'popular'::text, p_limit integer DEFAULT 24, p_offset integer DEFAULT 0, p_categories text[] DEFAULT NULL::text[], p_age_min_months integer DEFAULT NULL::integer, p_age_max_months integer DEFAULT NULL::integer, p_regions text[] DEFAULT NULL::text[], p_max_price numeric DEFAULT NULL::numeric, p_date_from date DEFAULT NULL::date, p_date_to date DEFAULT NULL::date, p_time_min integer DEFAULT NULL::integer, p_time_max integer DEFAULT NULL::integer, p_region_order text[] DEFAULT NULL::text[])
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
  -- Price range and venue count from activity_locations only (same reasoning
  -- as matching_activities' prc: no session scan on the catalogue path).
  r as (
    select m.*, prc.lo as price_from, prc.hi as price_to, greatest(1, coalesce(locs.n, 0))::int as location_count
    from m
    left join lateral (
      select min(z.v) as lo, max(z.v) as hi
      from (
        select m.price as v
        union all
        select coalesce(al.price, m.price) from public.activity_locations al where al.activity_id = m.id
        union all
        select (d.value #>> '{}')::numeric
        from public.activity_locations al, jsonb_each(al.day_prices) d
        where al.activity_id = m.id
      ) z
    ) prc on true
    left join lateral (
      select count(*) as n from public.activity_locations al where al.activity_id = m.id
    ) locs on true
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

grant execute on function public.search_activities(text,text,integer,date,double precision,double precision,double precision,text,integer,integer,text[],integer,integer,text[],numeric,date,date,integer,integer,text[]) to anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
