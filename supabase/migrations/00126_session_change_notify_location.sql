-- Extend notify_session_rescheduled (00044) to also fire on a location
-- change, not just date/time — the email-flows spec says "class date, time,
-- location etc". Also stamps activity_name into `data` so the new branded
-- session_rescheduled email template (lib/emails/render.ts) can bold the
-- activity name; previously only the in-app title/body carried it.
--
-- Kept the notification type (session_rescheduled) and the in-app
-- title/body as-is — the branded email's own copy is deliberately generic
-- ("review the details") per the spec rather than restating what moved.

create or replace function public.notify_session_rescheduled()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_title text;
begin
  if new.starts_at is distinct from old.starts_at
     or new.location_id is distinct from old.location_id then
    select a.title into v_title from public.activities a where a.id = new.activity_id;

    insert into public.notifications (user_id, type, title, body, data)
    select
      b.user_id,
      'session_rescheduled',
      'Class details changed',
      coalesce(v_title, 'A class') || ' has been updated by the provider — please review the new details.',
      jsonb_build_object('url', '/profile?tab=bookings', 'booking_id', b.id, 'activity_name', v_title)
    from public.bookings b
    where b.session_id = new.id
      and b.user_id is not null
      and b.status in ('pending', 'confirmed', 'waitlisted');
  end if;
  return new;
end;
$$;

drop trigger if exists on_session_rescheduled on public.activity_sessions;
create trigger on_session_rescheduled
  after update of starts_at, location_id on public.activity_sessions
  for each row execute function public.notify_session_rescheduled();
