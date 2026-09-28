-- 00185_fix_failing_scheduled_jobs.sql
--
-- Three pg_cron jobs were failing on production (found 28 Sep):
--
-- 1. booking-reminders (hourly) -- vendors' manual bookings have no parent
--    account, and inserting a reminder for user_id NULL aborted the whole run,
--    so NO parent got a reminder. Skip bookings without a parent.
-- 2. package-rebook-nudges (daily) -- joined packages.activity_id, a column
--    replaced by activity_ids in 00068, so it had never run successfully. As
--    a side effect expired purchases were never flipped to status 'expired'.
-- 3. refresh-recommendations (nightly) -- 00175 rewrote
--    compute_recommendations_for_child() without user_id, which is NOT NULL.
--
-- Idempotent.

create or replace function public.send_booking_reminders()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  insert into public.notifications (user_id, type, title, body, data)
  select b.user_id, 'booking_reminder', 'Class reminder ⏰',
         a.title || ' is coming up on '
           || to_char(s.starts_at at time zone 'Asia/Singapore', 'Dy DD Mon, HH12:MI AM') || '.',
         public.session_email_details(s.id) || jsonb_build_object(
           'url', '/profile?tab=bookings',
           'booking_id', b.id)
  from public.bookings b
  join public.activity_sessions s on s.id = b.session_id
  join public.activities a on a.id = s.activity_id
  where b.status = 'confirmed' and b.reminded_at is null
    and s.starts_at between now() and now() + interval '36 hours'
    -- 00185: a manual booking has no parent account to remind.
    and b.user_id is not null;

  update public.bookings b set reminded_at = now()
  from public.activity_sessions s
  where s.id = b.session_id and b.status = 'confirmed' and b.reminded_at is null
    and s.starts_at between now() and now() + interval '36 hours';
end;
$function$;

create or replace function public.send_package_rebook_nudges()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_yesterday date := (now() at time zone 'Asia/Singapore')::date - 1;
begin
  insert into public.notifications (user_id, type, title, body, data)
  select pp.user_id, 'package_rebook', 'Would you like to re-book your package?',
    'Your package with ' || pr.business_name || ' has expired.',
    jsonb_build_object(
      'provider_name', pr.business_name,
      'url', case when a.slug is not null then '/activity?slug=' || a.slug else '/explore' end
    )
  from public.package_purchases pp
  join public.packages pk on pk.id = pp.package_id
  join public.providers pr on pr.id = pp.provider_id
  -- 00185: packages link classes through activity_ids (00068), not the
  -- activity_id this referenced -- which made every run fail.
  left join public.activities a on a.id = pk.activity_ids[1]
  where pp.status = 'active'
    and pp.expires_at is not null
    and (pp.expires_at at time zone 'Asia/Singapore')::date = v_yesterday;

  update public.package_purchases
  set status = 'expired'
  where status = 'active'
    and expires_at is not null
    and (expires_at at time zone 'Asia/Singapore')::date = v_yesterday;
end;
$function$;

create or replace function public.compute_recommendations_for_child(p_child_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  -- 00185: user_id is NOT NULL; 00175 dropped it from this insert, so every
  -- nightly refresh failed from 25 Sep.
  insert into public.user_recommendations (user_id, child_id, activity_id, score, reasons)
  select
    v_child.parent_id, p_child_id, s.id, s.age_pts + s.interest_pts + s.location_pts + s.budget_pts + s.schedule_pts,
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
$function$;
