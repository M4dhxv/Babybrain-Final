-- BabyBrain Phase 1 — Functions, triggers, cron, seed data
-- Idempotent: create or replace functions, drop-if-exists triggers,
-- unschedule-then-schedule cron jobs, on-conflict seed.

-- =============================================================
-- Helpers
-- =============================================================

-- Age in months from a date of birth (used by matching + UI summaries)
create or replace function public.child_age_months(dob date)
returns int
language sql stable
as $$
  select (extract(year from age(current_date, dob)) * 12
        + extract(month from age(current_date, dob)))::int;
$$;

-- Haversine distance in km (good enough at city scale; avoids PostGIS)
create or replace function public.distance_km(
  lat1 double precision, lng1 double precision,
  lat2 double precision, lng2 double precision
) returns double precision
language sql immutable
as $$
  select 6371 * 2 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2)
    + cos(radians(lat1)) * cos(radians(lat2))
      * power(sin(radians(lng2 - lng1) / 2), 2)
  ));
$$;

-- Bucket a session start into morning/afternoon/evening (Singapore time)
create or replace function public.time_of_day(ts timestamptz)
returns text
language sql stable
as $$
  select case
    when extract(hour from ts at time zone 'Asia/Singapore') < 12 then 'morning'
    when extract(hour from ts at time zone 'Asia/Singapore') < 17 then 'afternoon'
    else 'evening'
  end;
$$;

-- Generic updated_at maintenance
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_updated_at on public.parent_profiles;
create trigger set_updated_at before update on public.parent_profiles
  for each row execute function public.set_updated_at();
drop trigger if exists set_updated_at on public.user_preferences;
create trigger set_updated_at before update on public.user_preferences
  for each row execute function public.set_updated_at();
drop trigger if exists set_updated_at on public.children;
create trigger set_updated_at before update on public.children
  for each row execute function public.set_updated_at();
drop trigger if exists set_updated_at on public.activities;
create trigger set_updated_at before update on public.activities
  for each row execute function public.set_updated_at();
drop trigger if exists set_updated_at on public.reviews;
create trigger set_updated_at before update on public.reviews
  for each row execute function public.set_updated_at();

-- =============================================================
-- Auth: create profile + preferences + welcome notification on signup
-- (works for email/password and Google OAuth alike)
-- =============================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.parent_profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', '')
  )
  on conflict (id) do nothing;

  insert into public.user_preferences (user_id) values (new.id)
  on conflict (user_id) do nothing;

  insert into public.notifications (user_id, type, title, body, data)
  values (
    new.id, 'welcome', 'Welcome to BabyBrain!',
    'Tell us about your child to get personalised activity recommendations.',
    '{"url": "/onboarding"}'
  );

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- =============================================================
-- Reviews: keep activities.rating_avg / rating_count in sync
-- =============================================================
create or replace function public.refresh_activity_rating()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_activity_id uuid := coalesce(new.activity_id, old.activity_id);
begin
  update public.activities a
  set rating_avg   = coalesce(r.avg_rating, 0),
      rating_count = coalesce(r.cnt, 0)
  from (
    select round(avg(rating)::numeric, 2) as avg_rating, count(*) as cnt
    from public.reviews
    where activity_id = v_activity_id
  ) r
  where a.id = v_activity_id;
  return null;
end;
$$;

drop trigger if exists on_review_change on public.reviews;
create trigger on_review_change
  after insert or update or delete on public.reviews
  for each row execute function public.refresh_activity_rating();

-- =============================================================
-- Recommendation engine (deterministic, no AI)
--
-- Score out of 100:
--   Age match        30  (hard prefilter: child age within range ±3 months;
--                         exact range: 30, near-miss: 15)
--   Interest match   30  (child interests ∪ parent interests vs category/tags)
--   Location match   20  (≤3km: 20, ≤7km: 12, ≤15km: 5; unknown: 5)
--   Budget match     10  (price ≤ budget_max: 10; unknown: 5)
--   Schedule match   10  (an upcoming session on a preferred day & time)
--
-- Keeps the top 20 activities scoring ≥ 30 per child, with
-- human-readable reasons for the "Why these activities?" panel.
-- =============================================================
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
  select * into v_prefs  from public.user_preferences where user_id = v_child.parent_id;

  v_age := public.child_age_months(v_child.date_of_birth);
  v_interests := v_child.interests || coalesce(v_prefs.interests, '{}');

  delete from public.user_recommendations where child_id = p_child_id;

  insert into public.user_recommendations (user_id, child_id, activity_id, score, reasons)
  select
    v_child.parent_id,
    p_child_id,
    s.id,
    s.age_pts + s.interest_pts + s.location_pts + s.budget_pts + s.schedule_pts,
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
    where a.is_published
      and v_age between a.age_min_months - 3 and a.age_max_months + 3
  ) s
  where s.age_pts + s.interest_pts + s.location_pts + s.budget_pts + s.schedule_pts >= 30
  order by s.age_pts + s.interest_pts + s.location_pts + s.budget_pts + s.schedule_pts desc
  limit 20;
end;
$$;

-- Recompute for every child of one parent (after preference/location edits)
create or replace function public.compute_recommendations_for_parent(p_parent_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  perform public.compute_recommendations_for_child(id)
  from public.children where parent_id = p_parent_id;
end;
$$;

-- Triggers: keep recommendations fresh as inputs change
create or replace function public.trg_child_changed()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  perform public.compute_recommendations_for_child(new.id);
  return new;
end;
$$;

drop trigger if exists on_child_changed on public.children;
create trigger on_child_changed
  after insert or update of date_of_birth, interests on public.children
  for each row execute function public.trg_child_changed();

create or replace function public.trg_preferences_changed()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  perform public.compute_recommendations_for_parent(new.user_id);
  return new;
end;
$$;

drop trigger if exists on_preferences_changed on public.user_preferences;
create trigger on_preferences_changed
  after update on public.user_preferences
  for each row execute function public.trg_preferences_changed();

create or replace function public.trg_profile_location_changed()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  perform public.compute_recommendations_for_parent(new.id);
  return new;
end;
$$;

drop trigger if exists on_profile_location_changed on public.parent_profiles;
create trigger on_profile_location_changed
  after update of latitude, longitude on public.parent_profiles
  for each row execute function public.trg_profile_location_changed();

-- =============================================================
-- Explore page search (one RPC handles all filter pills)
-- =============================================================
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
  dist_km double precision
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
         then public.distance_km(p_lat, p_lng, a.latitude, a.longitude) end
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
    case when p_sort = 'rating' then a.rating_avg end desc nulls last,
    case when p_sort = 'distance' and p_lat is not null and a.latitude is not null
         then public.distance_km(p_lat, p_lng, a.latitude, a.longitude)
    end asc nulls last,
    a.popularity desc,
    a.created_at desc
  limit p_limit offset p_offset;
$$;

-- =============================================================
-- Dashboard journey stats (classes attended, venues, hours)
-- =============================================================
create or replace function public.child_journey_stats(p_child_id uuid)
returns table (classes_attended int, venues_explored int, hours_of_learning numeric)
language sql stable
as $$
  select
    count(*)::int,
    count(distinct a.id)::int,
    coalesce(round(sum(extract(epoch from (s.ends_at - s.starts_at)) / 3600)::numeric, 0), 0)
  from public.bookings b
  join public.activity_sessions s on s.id = b.session_id
  join public.activities a on a.id = s.activity_id
  where b.child_id = p_child_id and b.status = 'attended';
$$;

-- =============================================================
-- Nightly maintenance (pg_cron) — 18:00 UTC = 02:00 SGT
-- =============================================================
create extension if not exists pg_cron;

-- remove existing jobs before (re)scheduling so reruns are safe
select cron.unschedule(jobid) from cron.job
 where jobname in ('refresh-activity-popularity', 'refresh-recommendations');

-- popularity = favorites + 2x reviews (simple, deterministic)
select cron.schedule('refresh-activity-popularity', '0 18 * * *', $$
  update public.activities a
  set popularity = coalesce(f.cnt, 0) + 2 * a.rating_count
  from (select activity_id, count(*) as cnt
        from public.favorites group by activity_id) f
  where f.activity_id = a.id;
$$);

-- refresh all recommendations (picks up new activities/sessions)
select cron.schedule('refresh-recommendations', '30 18 * * *', $$
  select public.compute_recommendations_for_child(id) from public.children;
$$);

-- =============================================================
-- Seed: categories shown on the homepage
-- =============================================================
insert into public.activity_categories (slug, name, sort_order) values
  ('music',          'Music',            1),
  ('sensory-play',   'Sensory Play',     2),
  ('art-creativity', 'Art & Creativity', 3),
  ('movement',       'Movement',         4),
  ('early-learning', 'Early Learning',   5),
  ('parent-baby',    'Parent & Baby',    6)
on conflict (slug) do nothing;
