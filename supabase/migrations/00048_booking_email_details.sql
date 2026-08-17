-- QA 17/08/26: "Booking confirmation / reminder emails didn't have the booking
-- in it — should show the booking."
--
-- This was read on the sheet as a demo-data linkage problem. It isn't. The
-- email templates render the booking block from `notifications.data`, reading
-- activity_name / date_time / duration / address / type (lib/emails/render.ts,
-- `details()`), but both notification producers only ever wrote
-- `{url, booking_id}`. With none of those keys present `details()` returns an
-- empty string, so every booking email has gone out with the details silently
-- missing, for every account — not just the demo one.
--
-- Both producers now write the fields the templates actually read. Address
-- falls back through the session's location to the activity's own address, and
-- duration is only emitted when the session records an end time (most scraped
-- listings don't, and a made-up duration is worse than none).

begin;

create or replace function public.notify_booking_confirmed()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.user_id is not null
     and new.status = 'confirmed'
     and coalesce(old.status, '') <> 'confirmed' then
    insert into public.notifications (user_id, type, title, body, data)
    select new.user_id, 'booking_confirmed', 'Booking confirmed 🎉',
           'Your booking for ' || a.title || ' is confirmed.',
           jsonb_strip_nulls(jsonb_build_object(
             'url', '/dashboard/bookings',
             'booking_id', new.id,
             'activity_name', a.title,
             'date_time', to_char(
               s.starts_at at time zone 'Asia/Singapore',
               'Dy DD Mon YYYY, HH12:MI AM'),
             'duration', case
               when s.ends_at is not null then
                 (extract(epoch from (s.ends_at - s.starts_at)) / 60)::int || ' minutes'
               else null end,
             'address', coalesce(l.address, a.address),
             'type', p.business_name
           ))
    from public.activity_sessions s
    join public.activities a on a.id = s.activity_id
    left join public.providers p on p.id = a.provider_id
    left join public.provider_locations l on l.id = s.location_id
    where s.id = new.session_id;
  end if;
  return new;
end;
$function$;

create or replace function public.send_booking_reminders()
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.notifications (user_id, type, title, body, data)
  select b.user_id, 'booking_reminder', 'Class reminder ⏰',
         a.title || ' is coming up on '
           || to_char(s.starts_at at time zone 'Asia/Singapore', 'Dy DD Mon, HH12:MI AM') || '.',
         jsonb_strip_nulls(jsonb_build_object(
           'url', '/dashboard/bookings',
           'booking_id', b.id,
           'activity_name', a.title,
           'date_time', to_char(
             s.starts_at at time zone 'Asia/Singapore',
             'Dy DD Mon YYYY, HH12:MI AM'),
           'duration', case
             when s.ends_at is not null then
               (extract(epoch from (s.ends_at - s.starts_at)) / 60)::int || ' minutes'
             else null end,
           'address', coalesce(l.address, a.address),
           'type', p.business_name
         ))
  from public.bookings b
  join public.activity_sessions s on s.id = b.session_id
  join public.activities a on a.id = s.activity_id
  left join public.providers p on p.id = a.provider_id
  left join public.provider_locations l on l.id = s.location_id
  where b.status = 'confirmed' and b.reminded_at is null
    and s.starts_at between now() and now() + interval '36 hours';

  update public.bookings b set reminded_at = now()
  from public.activity_sessions s
  where s.id = b.session_id and b.status = 'confirmed' and b.reminded_at is null
    and s.starts_at between now() and now() + interval '36 hours';
end;
$$;

commit;
