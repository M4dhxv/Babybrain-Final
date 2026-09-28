-- 00188_block_cancel_event_course.sql
--
-- A parent cannot cancel a booked Wix Event ticket or a Wix COURSE enrolment:
-- both are reserved inside Wix, and the parent app already says so and hides the
-- Cancel button (ProfilePage's cancelBlockReason). But cancel_booking and
-- cancel_booking_group — which the app still calls directly from the browser
-- for a single seat of a party (cancelPlace) and for any non-Wix-linked
-- booking — never checked the activity's type, so a direct RPC call could cancel
-- an Event or Course booking locally while the ticket stayed valid in Wix.
-- /api/wix/bookings/cancel got the same guard in the app; this closes the
-- database side so it holds for every caller.
--
-- Both functions are 00133's (session-over-activity policy coalescing)
-- verbatim, plus one check on activities.wix_service_type. Grants are kept by
-- create or replace. Idempotent.

begin;

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
  v_type text;
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
         coalesce(s.cancellation_refund_mode, a.cancellation_refund_mode),
         a.wix_service_type
    into v_allow, v_cutoff, v_starts, v_mode, v_type
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  where s.id = v_bk.session_id;

  if v_type = 'EVENT' then
    raise exception 'This is a ticketed event — it can''t be cancelled once booked. Contact the provider if you need help.';
  end if;
  if v_type = 'COURSE' then
    raise exception 'This is a course — it can''t be cancelled once booked. Contact the provider if you need help.';
  end if;
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
  v_type   text;
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
         coalesce(s.cancellation_refund_mode, a.cancellation_refund_mode),
         a.wix_service_type
    into v_allow, v_cutoff, v_starts, v_mode, v_type
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  where s.id = v_session;

  if v_type = 'EVENT' then
    raise exception 'This is a ticketed event — it can''t be cancelled once booked. Contact the provider if you need help.';
  end if;
  if v_type = 'COURSE' then
    raise exception 'This is a course — it can''t be cancelled once booked. Contact the provider if you need help.';
  end if;
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

notify pgrst, 'reload schema';

commit;
