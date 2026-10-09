-- 00230_low_schedule_nudge_only_when_low.sql
--
-- The Monday "Time to add to your schedule" nudge (00195) was reaching nearly every vendor.
--
-- Its test was "fewer than 3 bookable sessions in the next 14 days", which is true of:
--   * a vendor with nothing published at all (0 sessions) - 23 of the 31 eligible vendors on 9 Oct;
--   * any vendor running one weekly class: that is 2 sessions in 14 days, however far ahead the
--     schedule is filled (Grounded Spaces, Oma Studio and Physio Down Under were all nudged on
--     5 Oct with sessions booked into December).
--
-- Rule now (QA, 9 Oct): nudge only when the schedule really is running out, i.e. the vendor has
-- something live for parents to book and either
--   * fewer than 3 upcoming bookable sessions in total, or
--   * the last of them is within the next 7 days.
--
-- A vendor with no published, unpaused activity is no longer nudged: there is no schedule to add
-- to yet, and "your schedule is looking a little light" every Monday is the wrong message for
-- them. Everything else is as 00195 left it (who counts as eligible, Wix-linked vendors skipped,
-- at most once a week, the cron job itself).
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
    select p.id as provider_id, count(s.id)::int as upcoming, max(s.starts_at) as last_session
      from public.providers p
      join public.activities a
        on a.provider_id = p.id
       and a.is_published
       and not coalesce(a.bookings_paused, false)
      left join public.activity_sessions s
        on s.activity_id = a.id
       and s.starts_at > now()
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
        or max(s.starts_at) <= now() + interval '7 days'
  )
  insert into public.notifications (user_id, type, title, body, data)
  select m.user_id, 'provider_add_activities', 'Time to add to your schedule',
         'Your schedule is looking a little light — add more sessions so parents can book.',
         jsonb_build_object('url', '/vendor', 'provider_id', low.provider_id,
                            'upcoming_sessions', low.upcoming, 'last_session_at', low.last_session)
    from low
    join public.provider_members m
      on m.provider_id = low.provider_id and m.status = 'active';

  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- create or replace keeps the existing grants, but say it again: this is a cron-only function
-- (see 00229 and scripts/check-exposed-functions.mjs).
revoke all on function public.send_low_schedule_nudges() from public, anon, authenticated;
