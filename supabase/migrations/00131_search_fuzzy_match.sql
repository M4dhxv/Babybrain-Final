-- 00131_search_fuzzy_match.sql
--
-- "Bharatnatyam" (missing the middle "a") returned zero Explore results even
-- though the stored activity is titled "Bharatanatyam" (or similar) —
-- search_activities only matched via websearch_to_tsquery, which does
-- lexeme/stem matching, not typo tolerance. A single missing/extra/swapped
-- letter changes the token enough that nothing matches at all, which reads to
-- a parent as "this activity doesn't exist" rather than "you mistyped it".
--
-- Add pg_trgm word-similarity as a fallback alongside full-text search: FTS
-- still runs first and remains the primary match for correctly-spelled
-- multi-word queries, but a near-miss on the activity title, provider name,
-- or category name now matches too. word_similarity (not plain similarity)
-- is used because it scores the query against the best-matching word-extent
-- of the target, so a short/misspelled query still scores well against a
-- long title ("Bharatnatyam" vs "Bharatanatyam for Toddlers ages 3-6").
-- Threshold is relaxed from pg_trgm's default (0.6) to 0.45 — enough to
-- forgive a single-letter typo while still requiring most of the word to
-- line up, so e.g. "music" doesn't start matching unrelated short titles.
--
-- Idempotent.

begin;

create extension if not exists pg_trgm;

create index if not exists activities_title_trgm_idx
  on public.activities using gin (title gin_trgm_ops);
create index if not exists providers_business_name_trgm_idx
  on public.providers using gin (business_name gin_trgm_ops);
create index if not exists activity_categories_name_trgm_idx
  on public.activity_categories using gin (name gin_trgm_ops);

-- Return-column set is unchanged from 00130, so create or replace can update
-- the body in place — no drop needed this time.
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
  provider_logo_url text, provider_cover_image_url text, provider_gallery_urls text[])
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
      round(extract(epoch from (nxt.ends_at - nxt.starts_at)) / 60)::int,
      dur.mins
    ),
    (a.external_booking_url is null) as instant_book,
    a.image_source, a.cover_image_url,
    p.logo_url, p.cover_image_url, p.gallery_urls
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
