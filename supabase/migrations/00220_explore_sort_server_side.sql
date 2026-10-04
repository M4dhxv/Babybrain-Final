-- Explore sorting is done in Postgres, across the whole result set.
--
-- Until now only 'popular', 'price_asc' and 'price_desc' were ordered here:
-- "Starting soonest" and "Nearest" re-sorted just the rows the browser had
-- loaded, which is fine for one page and wrong once there are more activities
-- than a page ("soonest" showed the soonest of the first 50, not of all).
--
--  * p_sort = 'soonest'  -> earliest next session first.
--  * p_sort = 'distance' -> nearest venue first (p_lat/p_lng); with
--    p_region_order (areas nearest-first) the nearest area ranks before the
--    next, matching the "pick your area" fallback.
--  * id is now the final ORDER BY key so pagination is stable.
--
-- Adds a trailing parameter, so the old signature is dropped (leaving both
-- would make PostgREST calls ambiguous). Apply this BEFORE deploying the
-- front end that sends p_region_order.

drop function if exists public.search_activities(text,text,integer,date,double precision,double precision,double precision,text,integer,integer,text[],integer,integer,text[],numeric,date,date,integer,integer);

CREATE OR REPLACE FUNCTION public.search_activities(p_query text DEFAULT NULL::text, p_category_slug text DEFAULT NULL::text, p_age_months integer DEFAULT NULL::integer, p_date date DEFAULT NULL::date, p_lat double precision DEFAULT NULL::double precision, p_lng double precision DEFAULT NULL::double precision, p_radius_km double precision DEFAULT NULL::double precision, p_sort text DEFAULT 'popular'::text, p_limit integer DEFAULT 24, p_offset integer DEFAULT 0, p_categories text[] DEFAULT NULL::text[], p_age_min_months integer DEFAULT NULL::integer, p_age_max_months integer DEFAULT NULL::integer, p_regions text[] DEFAULT NULL::text[], p_max_price numeric DEFAULT NULL::numeric, p_date_from date DEFAULT NULL::date, p_date_to date DEFAULT NULL::date, p_time_min integer DEFAULT NULL::integer, p_time_max integer DEFAULT NULL::integer, p_region_order text[] DEFAULT NULL::text[])
 RETURNS TABLE(id uuid, slug text, title text, category_slug text, category_name text, age_min_months integer, age_max_months integer, price numeric, image_urls text[], latitude double precision, longitude double precision, rating_avg numeric, rating_count integer, popularity integer, next_session_at timestamp with time zone, dist_km double precision, boosted boolean, provider_id uuid, provider_name text, address text, region text, duration_mins integer, instant_book boolean, image_source text, cover_image_url text, provider_logo_url text, provider_cover_image_url text, provider_gallery_urls text[], is_course boolean, run_starts_at timestamp with time zone, run_ends_at timestamp with time zone, category_2_slug text, category_2_name text, areas text[], venues jsonb, total_count bigint, is_custom_location boolean, custom_location_label text)
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
    -- 'soonest': the earliest upcoming session first, across the whole result
    -- set (the client only ever holds one page, so it cannot do this itself).
    case when p_sort = 'soonest' then next_session_at end asc nulls last,
    -- 'distance' with only an area picked: the whole nearest area ranks first,
    -- then the next-nearest (p_region_order is nearest-first).
    case when p_sort = 'distance' and p_lat is not null and p_region_order is not null
         then (select min(array_position(p_region_order, r)) from unnest(areas) r) end asc nulls last,
    -- 'distance': nearest venue of a multi-venue listing, not just its first.
    case when p_sort = 'distance' and p_lat is not null
         then coalesce(
                (select min(public.distance_km(p_lat, p_lng, (v->>'lat')::float8, (v->>'lng')::float8))
                   from jsonb_array_elements(venues) v),
                dist_km) end asc nulls last,
    case when p_sort = 'rating' then rating_avg end desc nulls last,
    case when p_sort = 'price_asc' then price end asc nulls last,
    case when p_sort = 'price_desc' then price end desc nulls last,
    instant_book desc,
    boosted desc,
    popularity desc,
    created_at desc,
    -- A total order: without a unique last key, rows that tie can swap places
    -- between two page requests, so "Load more" repeats some activities and
    -- skips others.
    id
  limit p_limit offset p_offset;
$function$
;

grant execute on function public.search_activities(text,text,integer,date,double precision,double precision,double precision,text,integer,integer,text[],integer,integer,text[],numeric,date,date,integer,integer,text[]) to anon, authenticated, service_role;
