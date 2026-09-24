-- Onboarding and the profile-edit form both collect a region preference
-- (`user_preferences.preferred_regions`, the same "Central" chip Explore's
-- own area filter uses) and a postal code meant to drive distance scoring
-- (`parent_profiles.latitude/longitude`) — but compute_recommendations_for_child
-- never read preferred_regions at all, only ever scored raw geo-distance, and
-- nothing in the app was actually writing latitude/longitude (the
-- /api/geocode call existed but was only ever wired into the old Next.js
-- onboarding page, not the current Vite SPA one — see OnboardingPage.tsx and
-- dashboard.tsx's EditProfilePage, fixed alongside this migration). Together
-- that meant a parent's picked region and location were both silently
-- ignored: age alone (30 points) already clears the recommendation
-- threshold, so an activity anywhere on the island could win a slot in the
-- "curated activities" digest regardless of what the parent actually chose.
--
-- This migration makes an explicit preferred_regions match the primary
-- location signal (worth the same as "very near" on the old distance scale),
-- and falls back to distance only when no region preference is set.
-- suggested_activities_for_parent (the digest) goes further and hard-filters
-- to the preferred regions when set, rather than just nudging the ranking —
-- the digest already skips sending when nothing qualifies, so an empty
-- result for an unmatched run is the correct, existing behaviour.

begin;

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
        -- An explicit region choice wins outright over raw distance — it
        -- says more than a straight-line km ever can (a parent who works in
        -- one part of the island but lives in another, or who just prefers
        -- a particular area). Only falls back to distance when the parent
        -- never picked one.
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

-- One parent's top (up to 5) relevant, available, not-already-booked
-- activities in the next 7 days — same as before, but now hard-filtered to
-- the parent's preferred_regions when they've set any, instead of letting
-- score alone (where an age match already clears the bar on its own) pad the
-- digest with activities from anywhere in Singapore.
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
    where (prefs.regions = '{}' or coalesce(a.region, p.region) = any (prefs.regions))
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
  -- One session per activity — the highest-scoring, soonest-starting one.
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
