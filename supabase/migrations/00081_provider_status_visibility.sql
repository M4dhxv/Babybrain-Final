-- 00081_provider_status_visibility.sql
--
-- Fix H-1 (QA 2026-09-02): a published activity stayed publicly visible even
-- when its provider was `draft` or `suspended`.
--
-- Explore's search_activities and the "published activities are public" RLS
-- policies gated only on activities.is_published, never on providers.status.
-- So suspending a vendor (the moderation lever) did nothing to their listings,
-- and a vendor still in `draft` onboarding who published a class exposed it
-- before going live. This makes visibility require an ACTIVE provider.
--
-- An activity with no provider at all (provider_id is null — legacy/seed rows)
-- stays visible: coalesce(status,'active') treats "no provider" as not-hidden,
-- so this only ever hides the listings of a provider that actually exists and
-- is non-active.
--
-- LOW RISK: read-path only (search function + two SELECT policies). It does not
-- touch the booking triggers — the booking-time gate is 00082.

-- ---------- search_activities: require an active provider ----------
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
  address text, region text, duration_mins integer, instant_book boolean)
language sql stable
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
    -- NEW (H-1): only an active provider's listings are discoverable. Rows with
    -- no provider at all stay visible (coalesce → 'active').
    and coalesce(p.status, 'active') = 'active'
    and (p_query is null
         or a.search_tsv @@ websearch_to_tsquery('english', p_query)
         or to_tsvector('english', concat_ws(' ',
              coalesce(p.business_name, a.provider_name),
              coalesce(a.address, p.address),
              c.name
            )) @@ websearch_to_tsquery('english', p_query))
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

-- ---------- activities: published-and-active-provider is public ----------
drop policy if exists "published activities are public" on public.activities;
create policy "published activities are public" on public.activities
  for select using (
    is_published
    and (
      provider_id is null
      or exists (
        select 1 from public.providers p
        where p.id = activities.provider_id and p.status = 'active'
      )
    )
  );

-- ---------- activity_sessions: same gate as their activity ----------
drop policy if exists "sessions of published activities are public" on public.activity_sessions;
create policy "sessions of published activities are public" on public.activity_sessions
  for select using (
    exists (
      select 1 from public.activities a
      left join public.providers p on p.id = a.provider_id
      where a.id = activity_sessions.activity_id
        and a.is_published
        and coalesce(p.status, 'active') = 'active'
    )
  );
