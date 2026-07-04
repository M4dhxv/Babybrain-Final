-- BabyBrain — Featured/sponsored placement.
-- The vendor "Boost" flow already sets activities.boosted_until (Stripe webhook),
-- but search_activities ignored it. Recreate the RPC so currently-boosted
-- activities sort first and expose a `boosted` flag for the UI badge.
-- Adding a returned column changes the return type, so we must drop first.

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
  boosted boolean
)
language sql stable
as $$
  select
    a.id, a.slug, a.title,
    c.slug, c.name,
    a.age_min_months, a.age_max_months,
    a.price, a.image_urls, a.latitude, a.longitude,
    a.rating_avg, a.rating_count, a.popularity,
    (select min(s.starts_at) from public.activity_sessions s
      where s.activity_id = a.id and s.starts_at > now()),
    case when p_lat is not null and a.latitude is not null
         then public.distance_km(p_lat, p_lng, a.latitude, a.longitude) end,
    (a.boosted_until is not null and a.boosted_until > now()) as boosted
  from public.activities a
  join public.activity_categories c on c.id = a.category_id
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
    and (p_radius_km is null or p_lat is null or a.latitude is null
         or public.distance_km(p_lat, p_lng, a.latitude, a.longitude) <= p_radius_km)
  order by
    -- Featured (currently-boosted) listings always come first.
    (a.boosted_until is not null and a.boosted_until > now()) desc,
    case when p_sort = 'rating' then a.rating_avg end desc nulls last,
    case when p_sort = 'distance' and p_lat is not null and a.latitude is not null
         then public.distance_km(p_lat, p_lng, a.latitude, a.longitude)
    end asc nulls last,
    a.popularity desc,
    a.created_at desc
  limit p_limit offset p_offset;
$$;
