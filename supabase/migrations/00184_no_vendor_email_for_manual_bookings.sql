-- 00184_no_vendor_email_for_manual_bookings.sql
--
-- Manual bookings (a vendor recording an offline/walk-in booking from their
-- dashboard) no longer send the vendor "You've received a booking" or
-- "Your activity is fully booked" emails. Bookings made by parents, including
-- the companion seats of a multi-child booking (which keep the parent's
-- user_id), still notify exactly as before.
--
-- Idempotent.

create or replace function public.notify_provider_booking_received()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_capacity int;
  v_taken int;
  v_spaces_left int;
begin
  -- 00184: a manual booking is the vendor's own offline record (no parent
  -- account -- same rule as provider_session_roster's is_manual). Emailing
  -- the vendor about a booking they just typed in is noise: on 28 Sep Wonder
  -- Tots entering their roster sent 168 "You've received a booking" emails
  -- in 15 minutes. Parent-facing emails already skip these (user_id is null).
  if new.user_id is null and new.guest_name is not null then
    return new;
  end if;

  if new.status = 'confirmed'
     and coalesce(old.status, '') <> 'confirmed'
     and new.provider_id is not null then

    select s.capacity into v_capacity
    from public.activity_sessions s
    where s.id = new.session_id;

    select count(*) into v_taken
    from public.bookings b
    where b.session_id = new.session_id and b.status in ('pending', 'confirmed');

    v_spaces_left := case when v_capacity is null then null else greatest(v_capacity - v_taken, 0) end;

    insert into public.notifications (user_id, type, title, body, data)
    select m.user_id, 'provider_booking_received', 'You’ve received a booking 🎉',
           'You have received a booking for ' || a.title || '.',
           public.session_email_details(new.session_id) || jsonb_build_object(
             'url', '/vendor',
             'booking_id', new.id,
             'spaces_left', v_spaces_left)
    from public.provider_members m
    join public.activity_sessions s on s.id = new.session_id
    join public.activities a on a.id = s.activity_id
    where m.provider_id = new.provider_id and m.status = 'active';

    if v_capacity is not null and v_spaces_left <= 0 then
      insert into public.notifications (user_id, type, title, body, data)
      select m.user_id, 'provider_activity_full', 'Your activity is fully booked 🎉',
             a.title || ' is fully booked.',
             public.session_email_details(new.session_id) || jsonb_build_object(
               'url', '/vendor',
               'activity_id', a.id)
      from public.provider_members m
      join public.activity_sessions s on s.id = new.session_id
      join public.activities a on a.id = s.activity_id
      where m.provider_id = new.provider_id and m.status = 'active';
    end if;
  end if;
  return new;
end;
$function$;
