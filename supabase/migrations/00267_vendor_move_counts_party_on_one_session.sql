-- 00267_vendor_move_counts_party_on_one_session.sql
--
-- Issues sheet 2 Nov: "On a term booking, can't move between sessions. Get error 'That session is full
-- (0 of 6 places taken). Raise its capacity to move this party there.' It isn't full. A vendor should be
-- able to move a parent to any session with availability."
--
-- vendor_reschedule_booking (00249) worked out the party to move as every live booking sharing the
-- booking's booking_group_id. For a multi-child booking that is right: the seats are all on one session.
-- A term enrolment is different: all of its sessions share ONE booking group but sit on different
-- sessions, so moving a single class counted the whole term (say 20 seats) against the target's 6 places
-- and refused with "full". The party is now the group's live seats on the SAME session as the booking
-- being moved. Everything else in the function is unchanged.
--
-- service_role only, as before. Idempotent.

begin;

create or replace function public.vendor_reschedule_booking(
  p_provider uuid,
  p_booking_id uuid,
  p_new_session_id uuid,
  p_increase_capacity boolean default false
)
returns table (moved integer, new_starts_at timestamptz, capacity_raised integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bk public.bookings;
  v_old record;
  v_new record;
  v_ids uuid[];
  v_party int;
  v_taken int;
  v_raise int := 0;
  v_business text;
  v_old_venue text;
  v_new_venue text;
  v_changes jsonb;
begin
  select * into v_bk from public.bookings where id = p_booking_id;
  if not found then raise exception 'That booking no longer exists.'; end if;
  if v_bk.status not in ('pending', 'confirmed') then
    raise exception 'Only upcoming bookings can be moved.';
  end if;
  if p_new_session_id = v_bk.session_id then
    raise exception 'That booking is already on this session — pick a different one.';
  end if;

  select s.id, s.activity_id, s.starts_at, s.location_id, a.provider_id, a.title, a.wix_service_type
    into v_old
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  where s.id = v_bk.session_id;
  if v_old.provider_id is distinct from p_provider then
    raise exception 'That booking is not with your business.';
  end if;
  if v_old.wix_service_type in ('EVENT', 'COURSE') then
    raise exception 'Wix events and courses can''t be moved to another session.';
  end if;

  -- Lock the target for the capacity count and the move (same reason as 00160).
  select s.id, s.activity_id, s.starts_at, s.location_id, s.capacity, coalesce(s.status, 'scheduled') as status
    into v_new
  from public.activity_sessions s
  where s.id = p_new_session_id
  for update of s;
  if v_new.id is null or v_new.activity_id <> v_old.activity_id then
    raise exception 'You can only move a booking to another session of the same class.';
  end if;
  if v_new.status = 'cancelled' then
    raise exception 'That session has been cancelled.';
  end if;
  if v_new.starts_at <= now() then
    raise exception 'That session has already started.';
  end if;

  -- The whole party moves together (00084): the seats of this booking on this session.
  -- (A term enrolment's seats share one booking group but sit on different sessions; counting them all
  -- made one class look like a party of 20 and refused every move with "session is full".)
  if v_bk.booking_group_id is not null then
    select array_agg(id) into v_ids from public.bookings
     where booking_group_id = v_bk.booking_group_id and session_id = v_bk.session_id
       and status in ('pending', 'confirmed');
  else
    v_ids := array[v_bk.id];
  end if;
  v_party := coalesce(array_length(v_ids, 1), 1);

  if v_new.capacity is not null then
    select count(*) into v_taken from public.bookings
     where session_id = p_new_session_id and status in ('pending', 'confirmed');
    if v_taken + v_party > v_new.capacity then
      if not p_increase_capacity then
        raise exception 'That session is full (% of % places taken). Raise its capacity to move % there.',
          v_taken, v_new.capacity, case when v_party = 1 then 'this booking' else 'this party' end;
      end if;
      v_raise := v_taken + v_party - v_new.capacity;
      update public.activity_sessions set capacity = capacity + v_raise where id = p_new_session_id;
    end if;
  end if;

  update public.bookings set session_id = p_new_session_id where id = any(v_ids);

  -- Tell the parent by email and push (a manual entry has no parent account to tell). It's a
  -- 'session_rescheduled' notification — the same "What changed" email a parent gets when a vendor
  -- changes a booked session's time or venue (00209), built with the same helpers, so a move reads
  -- exactly like a change: Time old → new, and Venue old → new when the venue differs too.
  if v_bk.user_id is not null then
    select business_name into v_business from public.providers where id = p_provider;
    v_old_venue := public.change_venue(v_old.location_id, v_old.activity_id);
    v_new_venue := public.change_venue(v_new.location_id, v_new.activity_id);
    v_changes := jsonb_build_array(jsonb_build_object(
      'label', 'Time', 'old', public.change_when(v_old.starts_at), 'new', public.change_when(v_new.starts_at)));
    if v_new_venue is distinct from v_old_venue then
      v_changes := v_changes || jsonb_build_array(jsonb_build_object('label', 'Venue', 'old', v_old_venue, 'new', v_new_venue));
    end if;
    insert into public.notifications (user_id, type, title, body, data)
    values (
      v_bk.user_id,
      'session_rescheduled',
      'Booking moved',
      coalesce(v_business, 'Your provider') || ' has moved your booking for ' || coalesce(v_old.title, 'a class') || ' to ' ||
        to_char(v_new.starts_at at time zone 'Asia/Singapore', 'Dy DD Mon') || ' at ' ||
        to_char(v_new.starts_at at time zone 'Asia/Singapore', 'HH12:MIam') || '.',
      jsonb_build_object(
        'url', '/profile?tab=bookings',
        'booking_id', v_bk.id,
        'activity_name', v_old.title,
        'provider_name', v_business,
        'moved_by_provider', true,
        'changes', v_changes,
        'date_time', public.change_when(v_new.starts_at),
        'address', v_new_venue)
    );
  end if;

  return query select v_party, v_new.starts_at, v_raise;
end;
$$;

revoke all on function public.vendor_reschedule_booking(uuid, uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.vendor_reschedule_booking(uuid, uuid, uuid, boolean) to service_role;

notify pgrst, 'reload schema';

commit;
