-- 00103_fix_book_party_status_ambiguity.sql
--
-- book_party is declared `returns table (group_id uuid, status text)`, so
-- `status` is an implicit OUT parameter in its scope. Its body had two bare
-- `status` references — the capacity count and the per-seat RETURNING — which
-- a recent Supabase Postgres point-upgrade started treating as ambiguous
-- ("column reference \"status\" is ambiguous — a PL/pgSQL variable or a table
-- column"). Every native booking then failed with a scrubbed generic error.
--
-- Fix: `#variable_conflict use_column` plus qualifying both references.
-- Behaviour is unchanged by this migration (00104 changes the full-class
-- path).

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
  v_user     uuid := auth.uid();
  v_seats    int  := 1 + coalesce(array_length(p_guest_names, 1), 0);
  v_group    uuid := gen_random_uuid();
  v_session  record;
  v_child    uuid;
  v_taken    int;
  v_status   text;
  v_worst    text := 'confirmed';
  v_id       uuid;
  v_i        int;
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

  if v_session.capacity is not null then
    select count(*) into v_taken
    from public.bookings b
    where b.session_id = p_session_id
      and b.status in ('pending', 'confirmed');
    if v_taken + v_seats > v_session.capacity then
      raise exception 'Only % place(s) left on this session — reduce the number of children or pick another time.',
        greatest(v_session.capacity - v_taken, 0);
    end if;
  end if;

  for v_i in 1..v_seats loop
    insert into public.bookings (user_id, session_id, child_id, guest_name, policies_accepted,
                                 medical_disclosure, info_response, booking_group_id)
    values (
      v_user,
      p_session_id,
      case when v_i = 1 then v_child else null end,
      case when v_i = 1 then null
           else coalesce(nullif(btrim(p_guest_names[v_i - 1]), ''), 'Guest child') end,
      coalesce(p_policies, '{}'::uuid[]),
      case when v_i = 1 then nullif(btrim(p_medical), '') else null end,
      case when v_i = 1 then nullif(btrim(p_info), '') else null end,
      v_group
    )
    returning bookings.id, bookings.status into v_id, v_status;

    if v_status = 'waitlisted' then
      v_worst := 'waitlisted';
    elsif v_status = 'pending' and v_worst <> 'waitlisted' then
      v_worst := 'pending';
    end if;
  end loop;

  return query select v_group, v_worst;
end;
$function$;

notify pgrst, 'reload schema';

commit;
