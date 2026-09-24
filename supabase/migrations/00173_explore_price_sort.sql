-- Explore's "Sort & more filters" only ever offered Most popular / Nearest /
-- Starting soonest — no way to sort by price, which parents comparing
-- classes on a budget asked for directly. search_activities already picks
-- its ordering purely off the `p_sort` string (each case below is a no-op
-- unless it matches, so adding more never disturbs the existing ones);
-- this just adds the two price cases parent-app's Sort sheet now offers.

begin;

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
  areas text[], venues jsonb, total_count bigint)
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
    count(*) over() as total_count
  from m
  order by
    text_hit desc,
    case when p_sort = 'distance' and p_lat is not null and latitude is not null
         then dist_km end asc nulls last,
    case when p_sort = 'rating' then rating_avg end desc nulls last,
    -- "Price on enquiry" (null price) always sorts after every priced
    -- activity, in both directions — an unknown price is neither the
    -- cheapest nor the most expensive option, so it belongs at the bottom
    -- either way, not wherever NULLS FIRST/LAST would otherwise place it.
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

notify pgrst, 'reload schema';

commit;
