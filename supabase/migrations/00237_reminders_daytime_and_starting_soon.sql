-- 00237_reminders_daytime_and_starting_soon.sql
--
-- 1. Reminders only go out in the daytime (Singapore).
--    send_booking_reminders() runs hourly and used to create a reminder the
--    first run that a session fell inside the next 36 hours, at any hour: 14 of
--    22 reminders in a month were created between 22:00 and 07:00, which now
--    means a buzz at 02:00. The function now returns early outside 08:00-21:59
--    SGT. Nothing is lost: a booking that is not yet reminded stays eligible
--    (reminded_at is still null) and is picked up by the next daytime run.
--
-- 2. A second, short-notice reminder: "starts soon".
--    send_session_starting_soon() runs every 15 minutes and notifies once per
--    booking when its session starts 10-75 minutes from now, between 07:00 and
--    21:59 SGT. It is push only (email_status 'skipped'): an email an hour
--    before a class is noise.
--
-- Body of send_booking_reminders otherwise unchanged from 00228.
--
-- Idempotent.

begin;

alter table public.bookings
  add column if not exists starting_soon_reminded_at timestamptz;

create or replace function public.send_booking_reminders()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_hour integer := extract(hour from (now() at time zone 'Asia/Singapore'));
begin
  -- Daytime only (SGT). Unreminded bookings simply wait for the next run.
  if v_hour < 8 or v_hour >= 22 then
    return;
  end if;

  insert into public.notifications (user_id, type, title, body, data)
  select distinct on (b.user_id, coalesce(b.booking_group_id, b.id))
         b.user_id, 'booking_reminder', 'Class reminder ⏰',
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
    and b.user_id is not null
  order by b.user_id, coalesce(b.booking_group_id, b.id), b.created_at;

  update public.bookings b set reminded_at = now()
  from public.activity_sessions s
  where s.id = b.session_id and b.status = 'confirmed' and b.reminded_at is null
    and s.starts_at between now() and now() + interval '36 hours';
end;
$function$;

create or replace function public.send_session_starting_soon()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_hour integer := extract(hour from (now() at time zone 'Asia/Singapore'));
begin
  if v_hour < 7 or v_hour >= 22 then
    return;
  end if;

  insert into public.notifications (user_id, type, title, body, data, email_status)
  select distinct on (b.user_id, coalesce(b.booking_group_id, b.id))
         b.user_id, 'booking_starting_soon', 'Session starting soon ⏰',
         a.title || ' starts at '
           || to_char(s.starts_at at time zone 'Asia/Singapore', 'HH12:MI AM') || '.',
         jsonb_build_object('url', '/profile?tab=bookings', 'booking_id', b.id),
         'skipped'
  from public.bookings b
  join public.activity_sessions s on s.id = b.session_id
  join public.activities a on a.id = s.activity_id
  where b.status = 'confirmed' and b.starting_soon_reminded_at is null
    and b.user_id is not null
    and s.starts_at between now() + interval '10 minutes' and now() + interval '75 minutes'
  order by b.user_id, coalesce(b.booking_group_id, b.id), b.created_at;

  update public.bookings b set starting_soon_reminded_at = now()
  from public.activity_sessions s
  where s.id = b.session_id and b.status = 'confirmed' and b.starting_soon_reminded_at is null
    and s.starts_at between now() + interval '10 minutes' and now() + interval '75 minutes';
end;
$function$;

-- Internal job: not callable through the API.
revoke all on function public.send_session_starting_soon() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    perform cron.schedule('session-starting-soon', '*/15 * * * *', 'select public.send_session_starting_soon();');
  end if;
end $$;

notify pgrst, 'reload schema';

commit;
