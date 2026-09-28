-- 00195_low_schedule_vendor_nudge.sql
--
-- Founder request (guide review, 28 Sep): nudge a vendor to add sessions when
-- their schedule runs low. The "Add more to your schedule" email
-- (provider_add_activities, lib/emails/render.ts) already existed but nothing
-- ever sent it.
--
-- Rule (agreed 29 Sep): every Monday 10:00 SGT, every active team member of a
-- vendor that
--   * is active, has claimed its account and is not flagged as test data,
--   * has fewer than 3 bookable sessions in the next 14 days (published,
--     not paused, not cancelled, and the session itself not paused),
--   * has not had this nudge in the last 6 days (at most once a week).
--
-- Vendors with a live Wix-linked class or appointment are skipped: Wix owns
-- those schedules and BabyBrain only stores a Wix session once someone books
-- it, so the count here would always read "low" and nag them every week.
-- Wix ticketed events are stored as sessions, so they do count.
--
-- Idempotent.

create or replace function public.send_low_schedule_nudges()
returns int
language plpgsql
security definer set search_path = public
as $$
declare
  v_n int;
begin
  with low as (
    select p.id as provider_id, count(s.id)::int as upcoming
      from public.providers p
      left join public.activities a
        on a.provider_id = p.id
       and a.is_published
       and not coalesce(a.bookings_paused, false)
      left join public.activity_sessions s
        on s.activity_id = a.id
       and s.starts_at > now()
       and s.starts_at <= now() + interval '14 days'
       and coalesce(s.status, 'scheduled') <> 'cancelled'
       and not coalesce(s.bookings_paused, false)
     where p.status = 'active'
       and p.is_claimed
       and not coalesce(p.is_test, false)
       and not exists (
         select 1 from public.activities w
          where w.provider_id = p.id
            and w.is_published
            and w.wix_service_id is not null
            and w.wix_removed_at is null)
       and not exists (
         select 1 from public.notifications n
          where n.type = 'provider_add_activities'
            and n.data ->> 'provider_id' = p.id::text
            and n.created_at > now() - interval '6 days')
     group by p.id
    having count(s.id) < 3
  )
  insert into public.notifications (user_id, type, title, body, data)
  select m.user_id, 'provider_add_activities', 'Time to add to your schedule',
         'Your schedule is looking a little light — add more sessions so parents can book.',
         jsonb_build_object('url', '/vendor', 'provider_id', low.provider_id, 'upcoming_sessions', low.upcoming)
    from low
    join public.provider_members m
      on m.provider_id = low.provider_id and m.status = 'active';

  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public.send_low_schedule_nudges() from public, anon, authenticated;

select cron.unschedule(jobid) from cron.job where jobname = 'low-schedule-nudges';
select cron.schedule('low-schedule-nudges', '0 2 * * 1', $$select public.send_low_schedule_nudges();$$);
