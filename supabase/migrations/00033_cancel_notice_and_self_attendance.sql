-- 00033: Booking cancellation notice + parent-marked attendance.
--
-- QA findings:
--   * "When I cancelled a booking, I didn't get a notification under my
--     account" — only the waitlisted parent being promoted was notified; the
--     parent who cancelled got nothing.
--   * "Once time has passed for a class, it was still showing in bookings…
--     have an attended and not attended section [with] the option for the
--     person to mark themselves as not attended as well as the vendor" —
--     the attendance table was vendor-only, parents could neither read nor
--     write it.
--
-- Also fixes child_journey_stats, which counted bookings with status
-- 'attended' — a value the bookings status check has never allowed, so the
-- "Classes Attended" figure on the dashboard was always zero.

begin;

-- =============================================================
-- 1. Tell the parent their cancellation went through
-- =============================================================
create or replace function public.notify_booking_cancelled()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_title text;
begin
  if new.status = 'cancelled'
     and old.status is distinct from 'cancelled'
     and new.user_id is not null then
    select a.title into v_title
    from public.activity_sessions s
    join public.activities a on a.id = s.activity_id
    where s.id = new.session_id;

    insert into public.notifications (user_id, type, title, body, data)
    values (
      new.user_id,
      'booking_cancelled',
      'Booking cancelled',
      'Your booking for ' || coalesce(v_title, 'a class') ||
        ' has been cancelled. Any refund follows the provider''s policy.',
      jsonb_build_object('url', '/profile?tab=bookings', 'booking_id', new.id)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists on_booking_cancelled on public.bookings;
create trigger on_booking_cancelled
  after update of status on public.bookings
  for each row execute function public.notify_booking_cancelled();

-- =============================================================
-- 2. Parents can see, and set, attendance on their own bookings
-- =============================================================
drop policy if exists "parents read own attendance" on public.attendance;
create policy "parents read own attendance" on public.attendance
  for select using (
    exists (
      select 1 from public.bookings b
      where b.id = attendance.booking_id and b.user_id = auth.uid()
    )
  );

-- Writes go through this RPC rather than a policy so we can enforce that the
-- class has actually started before it can be marked.
create or replace function public.mark_own_attendance(p_booking_id uuid, p_status text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_session uuid;
  v_starts timestamptz;
begin
  if v_user is null then raise exception 'Not authenticated'; end if;
  if p_status not in ('present', 'absent') then
    raise exception 'Attendance must be present or absent.';
  end if;

  select b.session_id, s.starts_at into v_session, v_starts
  from public.bookings b
  join public.activity_sessions s on s.id = b.session_id
  where b.id = p_booking_id and b.user_id = v_user;

  if v_session is null then raise exception 'Booking not found'; end if;
  if v_starts > now() then
    raise exception 'This class hasn''t happened yet.';
  end if;

  insert into public.attendance (booking_id, session_id, status, marked_by, marked_at)
  values (p_booking_id, v_session, p_status, v_user, now())
  on conflict (booking_id) do update
    set status = excluded.status,
        marked_by = excluded.marked_by,
        marked_at = excluded.marked_at;

  -- Keep the booking in step so "Past activities" and the journey stats agree.
  update public.bookings
  set status = case when p_status = 'present' then 'completed' else status end
  where id = p_booking_id and status in ('pending', 'confirmed');

  return p_status;
end;
$$;

revoke all on function public.mark_own_attendance(uuid, text) from public;
grant execute on function public.mark_own_attendance(uuid, text) to authenticated;

-- =============================================================
-- 3. Journey stats counted a status that cannot exist
-- =============================================================
create or replace function public.child_journey_stats(p_child_id uuid)
returns table (classes_attended int, venues_explored int, hours_of_learning numeric)
language sql
stable
as $$
  select
    count(*)::int,
    count(distinct a.id)::int,
    coalesce(round(sum(extract(epoch from (s.ends_at - s.starts_at)) / 3600)::numeric, 0), 0)
  from public.bookings b
  join public.activity_sessions s on s.id = b.session_id
  join public.activities a on a.id = s.activity_id
  left join public.attendance att on att.booking_id = b.id
  where b.child_id = p_child_id
    and (
      att.status = 'present'
      or (att.status is null and b.status = 'completed')
    );
$$;

commit;
