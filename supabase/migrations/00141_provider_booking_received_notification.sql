-- The "New booking received" vendor email (provider_booking_received in
-- lib/emails/render.ts) had a template but nothing ever inserted the
-- notification row, so vendors never got it. Mirror the parent-facing
-- on_booking_confirmed trigger (00011/00090): fire when a booking flips to
-- 'confirmed', but fan it out to every active member of the booked
-- activity's provider instead of the parent.
--
-- Also fires "provider_activity_full" (add-capacity nudge) off the same
-- trigger, once, the moment the confirming booking fills the session's
-- capacity.

create or replace function public.notify_provider_booking_received()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_capacity int;
  v_taken int;
  v_spaces_left int;
begin
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

drop trigger if exists on_provider_booking_received on public.bookings;
create trigger on_provider_booking_received
  after insert or update of status on public.bookings
  for each row execute function public.notify_provider_booking_received();
