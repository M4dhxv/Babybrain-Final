-- Wire up "suggested_activities" (the weekly curated-activities digest).
-- Previously completely unwired — app/api/admin/email-flows/route.ts listed
-- it as "Not wired — this is the 'digest' flow; needs a weekly cron function."
--
-- Spec: for Plus parents, twice a week (Tue 9am + Thu 7pm Singapore time),
-- surface activities with open seats in the next 7 days that match their
-- preferences, up to 5, and skip sending if nothing qualifies.
--
-- Reuses the existing recommendation engine (compute_recommendations_for_child,
-- 00003_functions_triggers_seed.sql — refreshed nightly, scores per child on
-- age/interests/location/budget/schedule) rather than re-deriving relevance.
-- Wix Events are already mirrored into `activities`/`activity_sessions` with
-- their own session rows (00070_wix_events_as_activities.sql), so they flow
-- through this same query with no special-casing — a synced-and-published
-- event scores like any other activity (their fixed 'community-events'
-- category and full-range age fields mean they typically clear the
-- recommendation engine's threshold on age/location/budget/schedule alone).

-- One parent's top (up to 5) relevant, available, not-already-booked
-- activities in the next 7 days, in the exact shape the email template
-- expects (activity_name/date_time/duration/address/type via
-- session_email_details, plus a booking url).
create or replace function public.suggested_activities_for_parent(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with candidates as (
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
    join public.activity_sessions s on s.activity_id = a.id
      and s.starts_at between now() and now() + interval '7 days'
    where not exists (
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

-- Runs across every Plus parent; inserts one 'suggested_activities'
-- notification each, skipping anyone with nothing to show this run.
create or replace function public.send_suggested_activities_digest()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user record;
  v_activities jsonb;
begin
  for v_user in
    select cs.user_id
    from public.customer_subscriptions cs
    where cs.plan = 'plus' and cs.status in ('active', 'trialing')
  loop
    v_activities := public.suggested_activities_for_parent(v_user.user_id);
    if jsonb_array_length(v_activities) = 0 then
      continue;
    end if;

    insert into public.notifications (user_id, type, title, body, data)
    values (
      v_user.user_id,
      'suggested_activities',
      'Here are your curated activities 👶🧠',
      jsonb_array_length(v_activities) || ' activities we think you''d love this week.',
      jsonb_build_object('activities', v_activities)
    );
  end loop;
end;
$$;

-- Tuesday 09:00 SGT = 01:00 UTC Tuesday; Thursday 19:00 SGT = 11:00 UTC
-- Thursday (SGT is UTC+8 year-round, no DST — same conversion 00021 uses).
select cron.unschedule(jobid) from cron.job
 where jobname in ('suggested-activities-tue', 'suggested-activities-thu');
select cron.schedule('suggested-activities-tue', '0 1 * * 2', $$select public.send_suggested_activities_digest();$$);
select cron.schedule('suggested-activities-thu', '0 11 * * 4', $$select public.send_suggested_activities_digest();$$);
