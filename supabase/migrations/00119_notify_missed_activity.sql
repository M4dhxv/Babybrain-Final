-- Wire up the "missed_activity" email (email-flows spec: fires when a vendor
-- marks a booking as not attended). Previously nothing ever inserted a
-- notification of this type — see app/api/admin/email-flows/route.ts, which
-- listed it as "Not wired to anything yet."
--
-- Vendors mark attendance by writing directly to public.attendance from the
-- vendor portal (frontends/vendor/src/pages/BookingsPage.tsx, saveRoster()),
-- with marked_by set to the signed-in vendor staff member. Parents can also
-- self-report via mark_own_attendance() (migration 00033), with marked_by
-- set to themselves — that's not "you were missed", it's the parent already
-- telling us what happened, so it must not notify.

create or replace function public.notify_missed_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.bookings;
  v_activity_name text;
begin
  if new.status <> 'absent' then
    return new;
  end if;
  -- Only the transition into 'absent' — re-saving an unchanged roster (or
  -- flipping between other statuses) must not re-notify.
  if tg_op = 'UPDATE' and old.status = 'absent' then
    return new;
  end if;

  select * into v_booking from public.bookings where id = new.booking_id;
  if not found or v_booking.user_id is null then
    return new;
  end if;

  if new.marked_by is not null and new.marked_by = v_booking.user_id then
    return new;
  end if;

  select a.title into v_activity_name
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  where s.id = new.session_id;

  insert into public.notifications (user_id, type, title, body, data)
  values (
    v_booking.user_id,
    'missed_activity',
    'You were missed! 👶🧠',
    'We noticed you missed ' || coalesce(v_activity_name, 'your activity') || '.',
    jsonb_build_object(
      'activity_name', v_activity_name,
      'url', '/profile?tab=bookings',
      'booking_id', new.booking_id
    )
  );

  return new;
end;
$$;

drop trigger if exists on_attendance_marked_missed on public.attendance;
create trigger on_attendance_marked_missed
  after insert or update of status on public.attendance
  for each row execute function public.notify_missed_activity();
