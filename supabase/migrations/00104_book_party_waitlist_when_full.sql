-- 00104_book_party_waitlist_when_full.sql
--
-- book_party did an all-or-nothing capacity pre-check: if the whole party
-- didn't fit it raised "Only N place(s) left" and refused the booking. That
-- turned every full class away at the door — a single-place booking on a
-- full class never even reached the waitlist, so the waitlist was only ever
-- populated by races.
--
-- Now the party is accepted as far as it fits. The per-row capacity trigger
-- (handle_booking_insert, 00008) already does the work: seat by seat it lets
-- rows through as `pending` until the session is full, then flips the rest to
-- `waitlisted` with a queue position. A party of 3 into 2 free seats becomes
-- 2 pending + 1 waitlisted — same behaviour redeem_package_credit has always
-- had (00084).
--
-- What changes here is only the RETURN value, which the parent app reads to
-- decide whether to collect payment:
--
--   'pending'    -> at least one seat fits and is unpaid; send the party to
--                   Stripe. The checkout route charges just the pending seats
--                   and confirms them; the waitlisted overflow stays queued
--                   and is paid for later via the "Pay now" flow (00100).
--   'waitlisted' -> nothing fit; the whole party is queued, nothing to pay.
--   'confirmed'  -> free class, every seat is in.
--
-- Still carries the 00103 ambiguity fix (`#variable_conflict use_column` +
-- qualified `status` references) — `status` is an implicit OUT parameter here.

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
  v_user        uuid := auth.uid();
  v_seats       int  := 1 + coalesce(array_length(p_guest_names, 1), 0);
  v_group       uuid := gen_random_uuid();
  v_session     record;
  v_child       uuid;
  v_status      text;
  v_id          uuid;
  v_i           int;
  v_any_pending boolean := false;
  v_any_wait    boolean := false;
  v_ret         text;
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

  -- No capacity gate here. handle_booking_insert waitlists each row that
  -- doesn't fit, in order, so the party is taken as far as the session allows.
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
      v_any_wait := true;
    elsif v_status = 'pending' then
      v_any_pending := true;
    end if;
  end loop;

  -- Return contract read by the parent app (see file header).
  if v_any_pending then
    v_ret := 'pending';
  elsif v_any_wait then
    v_ret := 'waitlisted';
  else
    v_ret := 'confirmed';
  end if;

  return query select v_group, v_ret;
end;
$function$;

insert into supabase_migrations.schema_migrations (version, name)
values ('00103','fix_book_party_status_ambiguity'),
       ('00104','book_party_waitlist_when_full')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
