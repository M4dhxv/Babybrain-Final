-- 00199_suggested_activities_reweight.sql
--
-- The "suggested activities" on a parent's Home (user_recommendations, filled by
-- compute_recommendations_for_child) get new weights, a stricter cut-off, and
-- two eligibility rules; and the job that refreshes them runs hourly, not
-- nightly.
--
-- Weights (max 100, plus the +5 featured bonus from 00191):
--   age        40 in range / 20 within 3 months of it   (was 30 / 15)
--   interests  25                                        (was 30)
--   location   20                                        (unchanged)
--   budget     10 within / 5 unset / 0 over              (unchanged)
--   schedule    5 only when the parent set preferred days/times and a session
--               matches                                  (was 10, and it also
--               gave every parent with NO preference 10 and the label
--               "Fits your preferred schedule")
-- Minimum to be suggested: 50 (was 30), measured before the featured bonus, so
-- age alone is no longer enough — an in-range activity also needs at least one
-- more real signal.
--
-- New eligibility, applied before scoring:
--   * the activity needs an upcoming session (not cancelled, not paused for
--     bookings, not yet ended) — nothing is suggested that a parent can't book;
--   * its provider must be active (same rule as Explore, 00088). Before this a
--     row could point at an activity RLS then hid, which the Home page rendered
--     as a blank slot or, if all of them were hidden, as an empty section.
--
-- Freshness: the rows were only rebuilt nightly (02:30 SGT) or when the parent
-- edited their child/preferences, so an activity that was published, unpublished
-- or ran out of sessions during the day stayed wrong until the next night —
-- the "there in the morning, back in the evening" symptom. The job now runs
-- hourly, and every child is recomputed once at the end of this migration.
--
-- Body is 00191's, with the changes above. Idempotent.

create or replace function public.compute_recommendations_for_child(p_child_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
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

  insert into public.user_recommendations (user_id, child_id, activity_id, score, reasons)
  select
    v_child.parent_id, p_child_id, s.id, s.age_pts + s.interest_pts + s.location_pts + s.budget_pts + s.schedule_pts + s.featured_pts,
    array_remove(array[
      case when s.age_pts = 40     then 'Matches ' || v_child.name || '''s age' end,
      case when s.interest_pts > 0 then 'Matches ' || v_child.name || '''s interests' end,
      case when s.location_pts >= 12 then 'Near your location' end,
      case when s.budget_pts = 10  then 'Within your budget' end,
      case when s.schedule_pts > 0 then 'Fits your preferred schedule' end
    ], null)
  from (
    select
      a.id,
      case when v_age between a.age_min_months and a.age_max_months
           then 40 else 20 end as age_pts,
      case when c.slug = any (v_interests) or a.tags && v_interests
           then 25 else 0 end as interest_pts,
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
      -- Only a parent who actually set days and/or times can "match" them.
      case when (coalesce(v_prefs.preferred_days, '{}') <> '{}'
                 or coalesce(v_prefs.preferred_times, '{}') <> '{}')
             and exists (
        select 1 from public.activity_sessions s
        where s.activity_id = a.id
          and s.starts_at > now()
          and s.status <> 'cancelled'
          and s.bookings_paused = false
          and (coalesce(v_prefs.preferred_days, '{}') = '{}'
               or lower(trim(to_char(s.starts_at at time zone 'Asia/Singapore', 'dy')))
                  = any (v_prefs.preferred_days))
          and (coalesce(v_prefs.preferred_times, '{}') = '{}'
               or public.time_of_day(s.starts_at) = any (v_prefs.preferred_times))
      ) then 5 else 0 end as schedule_pts,
      -- 00191: "Priority ranking" for Premium vendors and Boosted activities.
      -- Added after the relevance cut below, so it only reorders activities
      -- that already match the child; it never lets a poor match in.
      case when (a.boosted_until is not null and a.boosted_until > now())
             or exists (
               select 1 from public.subscriptions sub
               where sub.provider_id = a.provider_id
                 and sub.plan in ('pro', 'premium')
                 and sub.status in ('active', 'trialing'))
           then 5 else 0 end as featured_pts
    from public.activities a
    join public.activity_categories c on c.id = a.category_id
    left join public.providers p on p.id = a.provider_id
    where a.is_published
      -- Same visibility rule as Explore (00088): no provider = visible.
      and coalesce(p.status, 'active') = 'active'
      and v_age between a.age_min_months - 3 and a.age_max_months + 3
      -- Nothing to book, nothing to suggest.
      and exists (
        select 1 from public.activity_sessions us
        where us.activity_id = a.id
          and us.ends_at > now()
          and us.status <> 'cancelled'
          and us.bookings_paused = false
      )
  ) s
  where s.age_pts + s.interest_pts + s.location_pts + s.budget_pts + s.schedule_pts >= 50
  order by s.age_pts + s.interest_pts + s.location_pts + s.budget_pts + s.schedule_pts + s.featured_pts desc
  limit 20;
end;
$function$;

-- Hourly instead of nightly (was '30 18 * * *' = 02:30 SGT, 00003).
select cron.unschedule(jobid) from cron.job where jobname = 'refresh-recommendations';
select cron.schedule('refresh-recommendations', '5 * * * *', $$
  select public.compute_recommendations_for_child(id) from public.children;
$$);

-- Apply the new weights and rules now rather than at the next run.
select public.compute_recommendations_for_child(id) from public.children;

notify pgrst, 'reload schema';
