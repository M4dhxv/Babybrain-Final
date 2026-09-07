-- 00104_book_party_waitlist_when_full.sql
--
-- book_party did an all-or-nothing capacity pre-check: if the whole party
-- didn't fit it raised "Only N place(s) left" and refused the booking. That
-- turned every full class away at the door — a single-place booking on a
-- full class never even reached the waitlist, so the waitlist was only ever
-- populated by races.
--
-- Now: if the whole party won't fit, the whole party is queued — every seat
-- goes in `waitlisted` with a position, nothing is charged, and the parent
-- pays for the lot later via the "Pay now" flow (00100) once enough seats
-- open. handle_booking_insert still waitlists a solo/party per row on a
-- genuinely full class; this also covers "3 wanted, 1 free" without leaving
-- a half-paid party.

begin;

create or replace function public.book_party(
  p_session_id  uuid,
  p_child_id    uuid default null,
  p_guest_names text[] default '{}',
  p_policies    uuid[] default '{}',
  p_medical     text default null,
  p_info        text default null
)
returns table (group_id uuid, status text)
language plpgsql
security definer
set search_path to 'public'
as $function$
#variable_conflict use_column
declare
  v_user      uuid := auth.uid();
  v_seats     int  := 1 + coalesce(array_length(p_guest_names, 1), 0);
  v_group     uuid := gen_random_uuid();
  v_session   record;
  v_child     uuid;
  v_taken     int;
  v_status    text;
  v_worst     text := 'confirmed';
  v_id        uuid;
  v_i         int;
  v_all_wait  boolean := false;
  v_wl_next   int := 1;
begin
  if v_user is null then
    raise exception 'Please log in again to book';
  end if;
  if v_seats < 1 or v_seats > 6 then
    raise exception 'You can book between 1 and 6 places at a time';
  end if;

  select s.id, s.activity_id, s.capacity, a.provider_id, a.bookings_paused
    into v_session
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  where s.id = p_session_id;
  if not found then
    raise exception 'That class time is no longer available — please pick another';
  end if;
  if coalesce(v_session.bookings_paused, false) then
    raise exception 'Bookings for this class are currently paused.';
  end if;

  if p_child_id is not null then
    select c.id into v_child
    from public.children c
    where c.id = p_child_id and c.parent_id = v_user;
    if v_child is null then
      raise exception 'That child is no longer on your profile — pick another';
    end if;
  end if;

  -- Whole party won't fit -> queue the whole party, in order. Nobody is
  -- charged; they pay once enough seats open.
  if v_session.capacity is not null then
    select count(*) into v_taken
    from public.bookings b
    where b.session_id = p_session_id
      and b.status in ('pending', 'confirmed');
    if v_taken + v_seats > v_session.capacity then
      v_all_wait := true;
      select coalesce(max(b.waitlist_position), 0) + 1 into v_wl_next
      from public.bookings b
      where b.session_id = p_session_id and b.status = 'waitlisted';
    end if;
  end if;

  for v_i in 1..v_seats loop
    insert into public.bookings (user_id, session_id, child_id, guest_name, policies_accepted,
                                 medical_disclosure, info_response, booking_group_id,
                                 status, waitlist_position)
    values (
      v_user,
      p_session_id,
      case when v_i = 1 then v_child else null end,
      case when v_i = 1 then null
           else coalesce(nullif(btrim(p_guest_names[v_i - 1]), ''), 'Guest child') end,
      coalesce(p_policies, '{}'::uuid[]),
      case when v_i = 1 then nullif(btrim(p_medical), '') else null end,
      case when v_i = 1 then nullif(btrim(p_info), '') else null end,
      v_group,
      case when v_all_wait then 'waitlisted' else null end,
      case when v_all_wait then v_wl_next + v_i - 1 else null end
    )
    returning bookings.id, bookings.status into v_id, v_status;

    if v_status = 'waitlisted' then
      v_worst := 'waitlisted';
    elsif v_status = 'pending' and v_worst <> 'waitlisted' then
      v_worst := 'pending';
    end if;
  end loop;

  -- A partly-waitlisted paid party is a trap: the client won't send them to
  -- Stripe once v_worst is 'waitlisted', so any 'pending' seats would sit
  -- unpaid forever. Put the whole group on the waitlist together.
  if v_worst = 'waitlisted' then
    update public.bookings b
    set status = 'waitlisted',
        waitlist_position = coalesce(
          (select max(x.waitlist_position) from public.bookings x
           where x.session_id = p_session_id and x.status = 'waitlisted'
             and x.booking_group_id is distinct from v_group), 0) + 1
    where b.booking_group_id = v_group and b.status = 'pending';
  end if;

  return query select v_group, v_worst;
end;
$function$;

notify pgrst, 'reload schema';

commit;
