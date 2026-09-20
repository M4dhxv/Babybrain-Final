-- 00160_lock_reschedule_target_session.sql
--
-- The last open finding from the 2026-09-20 bug audit. 00156 locked the
-- session row in handle_booking_insert() so two concurrent inserts for a
-- class's last seat could not both read "under capacity" and both succeed.
-- reschedule_booking() has the identical TOCTOU on the *target* session and
-- was left untouched by that migration:
--
--   1. it selects the target session (no lock),
--   2. counts bookings on it and compares to capacity,
--   3. updates bookings.session_id.
--
-- Nothing serializes 1-3 against another transaction doing the same, and the
-- capacity trigger does not cover this path at all — handle_booking_insert
-- fires on INSERT, while a reschedule is an UPDATE of session_id, which is
-- exactly why this function carries its own capacity check. So two parents
-- moving into the same last remaining seat (or one parent double-submitting)
-- both read taken < capacity under READ COMMITTED and both commit: the
-- session is oversold, with no error anywhere.
--
-- Fix is the same shape as 00156's: take the row lock when the target session
-- is first read, before the count, so a concurrent reschedule into the same
-- session waits rather than racing. `for update of s` locks only
-- activity_sessions, not the joined activities row.
--
-- Lock ordering is safe against 00156: both paths take at most one
-- activity_sessions row lock per transaction, so there is no cycle to
-- deadlock on.
--
-- Body is otherwise character-for-character the deployed definition
-- (00133_session_booking_policy_overrides.sql, verified against
-- pg_get_functiondef on the live database before writing this).
--
-- Idempotent.

begin;

create or replace function public.reschedule_booking(p_booking_id uuid, p_new_session_id uuid)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_user uuid := auth.uid();
  v_bk public.bookings;
  v_act_id uuid;
  v_act_title text;
  v_allow boolean;
  v_cutoff integer;
  v_old_starts timestamptz;
  v_new record;
  v_taken int;
begin
  if v_user is null then raise exception 'Not authenticated'; end if;

  select b.* into v_bk from public.bookings b
  where b.id = p_booking_id and b.user_id = v_user;
  if not found then raise exception 'Booking not found'; end if;
  if v_bk.status not in ('pending', 'confirmed') then
    raise exception 'Only upcoming bookings can be rescheduled.';
  end if;

  -- O-2: moving to the session it's already on is a no-op that used to
  -- "succeed" and fire a bogus "Booking moved" notification.
  if p_new_session_id = v_bk.session_id then
    raise exception 'That booking is already on this session — pick a different one.';
  end if;

  select a.id, a.title,
         coalesce(s.allow_rescheduling, a.allow_rescheduling),
         coalesce(s.reschedule_cutoff_hours, a.reschedule_cutoff_hours),
         s.starts_at
    into v_act_id, v_act_title, v_allow, v_cutoff, v_old_starts
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  where s.id = v_bk.session_id;

  if not v_allow then
    raise exception 'The provider does not allow rescheduling for this class.';
  end if;
  if v_old_starts - make_interval(hours => v_cutoff) < now() then
    raise exception 'The rescheduling window for this class has closed (% hours before the session).', v_cutoff;
  end if;

  -- Lock the TARGET session for the rest of this transaction. Everything
  -- below — the capacity count and the update that consumes the seat — has
  -- to be serialized against another reschedule aiming at the same session,
  -- or both can pass the check and oversell it.
  select s.id, s.activity_id, s.starts_at, s.capacity, s.bookings_paused, a.bookings_paused as activity_paused
    into v_new
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  where s.id = p_new_session_id
  for update of s;

  if v_new.id is null or v_new.activity_id <> v_act_id then
    raise exception 'You can only reschedule to another session of the same class.';
  end if;
  if v_new.starts_at <= now() then
    raise exception 'That session has already started.';
  end if;
  if coalesce(v_new.activity_paused, false) then
    raise exception 'Bookings for this class are currently paused.';
  end if;
  if coalesce(v_new.bookings_paused, false) then
    raise exception 'Bookings for that session are currently paused — please pick another date.';
  end if;
  if v_new.capacity is not null then
    select count(*) into v_taken from public.bookings
    where session_id = p_new_session_id and status in ('pending', 'confirmed');
    if v_taken >= v_new.capacity then
      raise exception 'That session is full.';
    end if;
  end if;

  update public.bookings set session_id = p_new_session_id where id = p_booking_id;

  insert into public.notifications (user_id, type, title, body, data)
  values (
    v_user,
    'booking_rescheduled',
    'Booking moved',
    'Your booking for ' || coalesce(v_act_title, 'a class') || ' is now on ' ||
      to_char(v_new.starts_at at time zone 'Asia/Singapore', 'Dy DD Mon') || ' at ' ||
      to_char(v_new.starts_at at time zone 'Asia/Singapore', 'HH12:MIam') || '.',
    public.session_email_details(p_new_session_id) || jsonb_build_object(
      'url', '/profile?tab=bookings',
      'booking_id', p_booking_id)
  );

  return v_bk.status;
end;
$function$;

notify pgrst, 'reload schema';

commit;
