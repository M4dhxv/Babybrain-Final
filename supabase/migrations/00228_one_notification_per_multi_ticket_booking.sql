-- 00228_one_notification_per_multi_ticket_booking.sql
--
-- Buying 2+ tickets in one go creates one bookings row per seat, all sharing a
-- booking_group_id (00084). The notification triggers and cron jobs work per
-- row, so the parent got one "booking confirmed" email and one reminder / follow-up
-- per ticket (and the vendor one "booking received" per ticket).
--
-- Now one per purchase:
--   * booking_confirmed / provider_booking_received: skipped when a sibling seat in
--     the same group was already notified in the last 10 minutes. The window keeps
--     a seat confirmed much later (e.g. promoted off the waitlist) from being
--     swallowed.
--   * booking_reminder / class_followup: one row per (parent, group). All seats are
--     still marked reminded / followed up, as before.
--
-- Solo bookings (booking_group_id null) behave exactly as before.

begin;

create or replace function public.group_sibling_notified(p_group uuid, p_self uuid, p_type text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select p_group is not null and exists (
    select 1
    from public.bookings sib
    join public.notifications n
      on n.type = p_type and n.data ->> 'booking_id' = sib.id::text
    where sib.booking_group_id = p_group
      and sib.id <> p_self
      and n.created_at > now() - interval '10 minutes'
  );
$$;

create or replace function public.notify_booking_confirmed()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.user_id is not null
     and new.status = 'confirmed'
     and coalesce(old.status, '') <> 'confirmed'
     -- 00228: a multi-ticket purchase is one booking, not one per seat.
     and not public.group_sibling_notified(new.booking_group_id, new.id, 'booking_confirmed') then
    insert into public.notifications (user_id, type, title, body, data)
    select new.user_id, 'booking_confirmed', 'Booking confirmed 🎉',
           'Your booking for ' || a.title || ' is confirmed.',
           public.session_email_details(new.session_id) || jsonb_build_object(
             'url', '/profile?tab=bookings',
             'booking_id', new.id)
    from public.activity_sessions s
    join public.activities a on a.id = s.activity_id
    where s.id = new.session_id;
  end if;
  return new;
end;
$function$;

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
     and new.provider_id is not null
     and not public.group_sibling_notified(new.booking_group_id, new.id, 'provider_booking_received') then

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

create or replace function public.send_booking_reminders()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
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

create or replace function public.send_class_followups()
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  insert into public.notifications (user_id, type, title, body, data)
  select distinct on (b.user_id, coalesce(b.booking_group_id, b.id))
         b.user_id, 'class_followup', 'How was the class? ⭐',
         'Hope you enjoyed ' || a.title || '! Leave a review to help other families.',
         jsonb_strip_nulls(jsonb_build_object(
           'activity_id', a.id,
           'activity_name', a.title,
           -- The review form lives on the activity page, under #reviews.
           'url', case when a.slug is not null
                       then '/activity?slug=' || a.slug || '#reviews'
                       else '/explore' end,
           'rebook_url', case when a.slug is not null
                              then '/book?slug=' || a.slug
                              else '/explore' end
         ))
  from public.bookings b
  join public.activity_sessions s on s.id = b.session_id
  join public.activities a on a.id = s.activity_id
  where b.status in ('confirmed', 'completed') and b.followed_up_at is null
    and s.ends_at between now() - interval '24 hours' and now()
    and b.user_id is not null
  order by b.user_id, coalesce(b.booking_group_id, b.id), b.created_at;

  update public.bookings b set followed_up_at = now()
  from public.activity_sessions s
  where s.id = b.session_id and b.status in ('confirmed', 'completed')
    and b.followed_up_at is null
    and s.ends_at between now() - interval '24 hours' and now();
end;
$$;

commit;
