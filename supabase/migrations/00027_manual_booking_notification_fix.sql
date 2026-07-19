-- 00027_manual_booking_notification_fix.sql
-- Manual (vendor-recorded) bookings have no parent user, so the
-- booking-confirmed notification trigger must skip them instead of violating
-- notifications.user_id NOT NULL.

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
           jsonb_build_object('url', '/dashboard/bookings', 'booking_id', new.id)
    from public.activity_sessions s
    join public.activities a on a.id = s.activity_id
    where s.id = new.session_id;
  end if;
  return new;
end;
$function$;
