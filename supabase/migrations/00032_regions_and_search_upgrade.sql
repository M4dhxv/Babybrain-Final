-- 00032: Singapore regions on every listing + a richer search RPC.
--
-- QA asked for:
--   * every listing classified as Central / East / North / North-East / West /
--     Sentosa, so the Area filter returns real results (it previously guessed
--     from provider coordinates and missed anything without them)
--   * the activity card to show area, duration and a "From $xx" price without
--     opening the listing
--   * integrated ("instant book") listings to always sort first
--
-- Regions come from the Singapore postal sector (first two digits of the
-- postcode), which is authoritative, falling back to nearest-region centroid
-- when we only have coordinates.

begin;

-- =============================================================
-- 1. Region helper
-- =============================================================
create or replace function public.sg_region(
  p_postal text,
  p_lat double precision default null,
  p_lng double precision default null
)
returns text
language plpgsql
immutable
as $$
declare
  sector int;
begin
  -- Sentosa has its own postal sectors and reads as its own area to parents.
  if p_postal ~ '^09[89]' then
    return 'sentosa';
  end if;

  if p_postal ~ '^\d{6}$' then
    sector := substring(p_postal from 1 for 2)::int;
    return case
      when sector between  1 and 10 then 'central'      -- Raffles → Harbourfront
      when sector between 11 and 13 then 'west'         -- Pasir Panjang, Clementi
      when sector between 14 and 37 then 'central'      -- Queenstown → Braddell
      when sector between 38 and 52 then 'east'         -- Geylang → Pasir Ris
      when sector between 53 and 57 then 'north-east'   -- Hougang, Bishan, AMK
      when sector between 58 and 71 then 'west'         -- Upper Bt Timah → Tengah
      when sector between 72 and 73 then 'north'        -- Kranji, Woodgrove
      when sector between 75 and 78 then 'north'        -- Yishun → Springleaf
      when sector in (79, 80, 82)   then 'north-east'   -- Seletar, Punggol
      when sector = 81              then 'east'         -- Loyang, Changi
      else null
    end;
  end if;

  if p_lat is not null and p_lng is not null then
    if p_lat < 1.262 and p_lng between 103.80 and 103.87 then
      return 'sentosa';
    end if;
    return (
      select r.name
      from (values
        ('central',    1.300, 103.830),
        ('east',       1.335, 103.940),
        ('north-east', 1.385, 103.895),
        ('north',      1.430, 103.820),
        ('west',       1.335, 103.720)
      ) as r(name, lat, lng)
      order by (p_lat - r.lat) ^ 2 + (p_lng - r.lng) ^ 2
      limit 1
    );
  end if;

  return null;
end;
$$;

-- =============================================================
-- 2. Region columns
-- =============================================================
alter table public.providers          add column if not exists region text;
alter table public.provider_locations add column if not exists region text;
alter table public.activities         add column if not exists region text;

create index if not exists providers_region_idx          on public.providers (region);
create index if not exists provider_locations_region_idx on public.provider_locations (region);
create index if not exists activities_region_idx         on public.activities (region);

-- Keep regions in step with postcode/coordinate edits.
create or replace function public.set_region_from_address()
returns trigger language plpgsql as $$
begin
  new.region := public.sg_region(new.postal_code, new.latitude, new.longitude);
  return new;
end;
$$;

drop trigger if exists providers_region_trg on public.providers;
create trigger providers_region_trg
  before insert or update of postal_code, latitude, longitude on public.providers
  for each row execute function public.set_region_from_address();

drop trigger if exists provider_locations_region_trg on public.provider_locations;
create trigger provider_locations_region_trg
  before insert or update of postal_code, latitude, longitude on public.provider_locations
  for each row execute function public.set_region_from_address();

-- An activity inherits its provider's region when it has no address of its own.
create or replace function public.set_activity_region()
returns trigger language plpgsql as $$
begin
  new.region := coalesce(
    public.sg_region(new.postal_code, new.latitude, new.longitude),
    (select p.region from public.providers p where p.id = new.provider_id)
  );
  return new;
end;
$$;

drop trigger if exists activities_region_trg on public.activities;
create trigger activities_region_trg
  before insert or update of postal_code, latitude, longitude, provider_id on public.activities
  for each row execute function public.set_activity_region();

-- =============================================================
-- 3. Backfill
-- =============================================================
update public.providers
set region = public.sg_region(postal_code, latitude, longitude)
where region is distinct from public.sg_region(postal_code, latitude, longitude);

update public.provider_locations
set region = public.sg_region(postal_code, latitude, longitude)
where region is distinct from public.sg_region(postal_code, latitude, longitude);

update public.activities a
set region = coalesce(
  public.sg_region(a.postal_code, a.latitude, a.longitude),
  (select p.region from public.providers p where p.id = a.provider_id)
)
where a.region is null;

-- =============================================================
-- 4. search_activities — richer payload + instant-book-first ordering
-- =============================================================
-- Adding returned columns changes the signature, so drop the old one first.
drop function if exists public.search_activities(
  text, text, int, date, double precision, double precision, double precision, text, int, int
);

create or replace function public.search_activities(
  p_query         text default null,
  p_category_slug text default null,
  p_age_months    int default null,
  p_date          date default null,
  p_lat           double precision default null,
  p_lng           double precision default null,
  p_radius_km     double precision default null,
  p_sort          text default 'popular',   -- 'popular' | 'rating' | 'distance'
  p_limit         int default 24,
  p_offset        int default 0
)
returns table (
  id uuid,
  slug text,
  title text,
  category_slug text,
  category_name text,
  age_min_months int,
  age_max_months int,
  price numeric,
  image_urls text[],
  latitude double precision,
  longitude double precision,
  rating_avg numeric,
  rating_count int,
  popularity int,
  next_session_at timestamptz,
  dist_km double precision,
  boosted boolean,
  provider_id uuid,
  provider_name text,
  address text,
  region text,
  duration_mins int,
  instant_book boolean
)
language sql stable
as $$
  select
    a.id, a.slug, a.title,
    c.slug, c.name,
    a.age_min_months, a.age_max_months,
    a.price, a.image_urls,
    -- Prefer the provider's coordinates so every listing of a venue-based
    -- business gets a map pin, even when the activity row has no address.
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
    (a.external_booking_url is null) as instant_book
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
    and (p_query is null
         or a.search_tsv @@ websearch_to_tsquery('english', p_query))
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
    -- Listings bookable on BabyBrain come first so parents aren't sent off
    -- platform, then paid featured placement, then the chosen sort.
    (a.external_booking_url is null) desc,
    (a.boosted_until is not null and a.boosted_until > now()) desc,
    case when p_sort = 'rating' then a.rating_avg end desc nulls last,
    case when p_sort = 'distance' and p_lat is not null and coalesce(a.latitude, p.latitude) is not null
         then public.distance_km(p_lat, p_lng, coalesce(a.latitude, p.latitude), coalesce(a.longitude, p.longitude))
    end asc nulls last,
    a.popularity desc,
    a.created_at desc
  limit p_limit offset p_offset;
$$;

commit;
