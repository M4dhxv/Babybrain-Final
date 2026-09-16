-- 00133_session_booking_policy_overrides.sql
--
-- Booking policies (allow cancellation / cancellation cut-off / refund mode,
-- allow rescheduling / reschedule cut-off) have so far lived only on
-- `activities`, applying to every session of a class. This lets a vendor
-- override any of them for one specific session ("schedule level") — e.g. a
-- one-off holiday class with a tighter cancellation window. A null value on
-- the session means "inherit the activity's setting", so every existing
-- session behaves exactly as before.
--
-- Three functions read these columns and are redefined here, unchanged
-- except for coalescing the session's own value over the activity's:
--   * cancel_booking / cancel_booking_group (00099_cancellation_refund_mode.sql)
--   * reschedule_booking (00091_session_pause_and_manual_bookings.sql)
-- compensate_cancelled_booking (00099) needs no change — it reads
-- bookings.cancel_refund_mode, which cancel_booking/cancel_booking_group
-- already stamp with the coalesced effective mode.

begin;

alter table public.activity_sessions
  add column if not exists allow_cancellation boolean,
  add column if not exists cancellation_cutoff_hours integer,
  add column if not exists cancellation_refund_mode text
    check (cancellation_refund_mode in ('refund', 'none')),
  add column if not exists allow_rescheduling boolean,
  add column if not exists reschedule_cutoff_hours integer;

comment on column public.activity_sessions.allow_cancellation is
  'Per-session override of activities.allow_cancellation. Null = inherit the activity default.';
comment on column public.activity_sessions.cancellation_cutoff_hours is
  'Per-session override of activities.cancellation_cutoff_hours. Null = inherit the activity default.';
comment on column public.activity_sessions.cancellation_refund_mode is
  'Per-session override of activities.cancellation_refund_mode. Null = inherit the activity default.';
comment on column public.activity_sessions.allow_rescheduling is
  'Per-session override of activities.allow_rescheduling. Null = inherit the activity default.';
comment on column public.activity_sessions.reschedule_cutoff_hours is
  'Per-session override of activities.reschedule_cutoff_hours. Null = inherit the activity default.';

-- =============================================================
-- cancel_booking / cancel_booking_group — coalesce session over activity
-- =============================================================
create or replace function public.cancel_booking(p_booking_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_user uuid := auth.uid();
  v_bk public.bookings;
  v_allow boolean;
  v_cutoff integer;
  v_starts timestamptz;
  v_mode text;
begin
  if v_user is null then raise exception 'Not authenticated'; end if;

  select b.* into v_bk from public.bookings b
  where b.id = p_booking_id and b.user_id = v_user;
  if not found then raise exception 'Booking not found'; end if;
  if v_bk.status not in ('pending', 'confirmed', 'waitlisted') then
    raise exception 'This booking can no longer be cancelled.';
  end if;

  select coalesce(s.allow_cancellation, a.allow_cancellation),
         coalesce(s.cancellation_cutoff_hours, a.cancellation_cutoff_hours),
         s.starts_at,
         coalesce(s.cancellation_refund_mode, a.cancellation_refund_mode)
    into v_allow, v_cutoff, v_starts, v_mode
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  where s.id = v_bk.session_id;

  if not v_allow then
    raise exception 'The provider does not allow cancellations for this class.';
  end if;
  if v_starts - make_interval(hours => v_cutoff) < now() then
    raise exception 'The cancellation window for this class has closed (% hours before the session).', v_cutoff;
  end if;

  update public.bookings
  set status = 'cancelled',
      cancel_refund_mode = coalesce(v_mode, 'refund')
  where id = p_booking_id;
end;
$$;

create or replace function public.cancel_booking_group(p_group_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_user   uuid := auth.uid();
  v_allow  boolean;
  v_cutoff integer;
  v_starts timestamptz;
  v_session uuid;
  v_live   int;
  v_mode   text;
begin
  if v_user is null then raise exception 'Not authenticated'; end if;

  select count(*), min(b.session_id)
    into v_live, v_session
  from public.bookings b
  where b.booking_group_id = p_group_id
    and b.user_id = v_user
    and b.status in ('pending', 'confirmed', 'waitlisted');
  if coalesce(v_live, 0) = 0 then
    raise exception 'This booking can no longer be cancelled.';
  end if;

  select coalesce(s.allow_cancellation, a.allow_cancellation),
         coalesce(s.cancellation_cutoff_hours, a.cancellation_cutoff_hours),
         s.starts_at,
         coalesce(s.cancellation_refund_mode, a.cancellation_refund_mode)
    into v_allow, v_cutoff, v_starts, v_mode
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  where s.id = v_session;

  if not v_allow then
    raise exception 'The provider does not allow cancellations for this class.';
  end if;
  if v_starts - make_interval(hours => v_cutoff) < now() then
    raise exception 'The cancellation window for this class has closed (% hours before the session).', v_cutoff;
  end if;

  update public.bookings
  set status = 'cancelled',
      cancel_refund_mode = coalesce(v_mode, 'refund')
  where booking_group_id = p_group_id
    and user_id = v_user
    and status in ('pending', 'confirmed', 'waitlisted');
end;
$function$;

-- =============================================================
-- reschedule_booking — coalesce session over activity
-- =============================================================
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

  select s.id, s.activity_id, s.starts_at, s.capacity, s.bookings_paused, a.bookings_paused as activity_paused
    into v_new
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  where s.id = p_new_session_id;
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
