-- 00136_party_booking_waitlist_count.sql
--
-- Both multi-seat booking RPCs (book_party 00104, redeem_package_credit
-- latest 00129) collapse a party that straddles capacity into a single
-- "worst status" string: as soon as ONE seat in the party lands
-- 'waitlisted', the whole call reports 'waitlisted' even when the other
-- seats are genuinely confirmed. The parent app then shows the full
-- "You're on the waitlist!" screen for a booking where most of their kids
-- actually got in — the /booked page already has the right UI for this
-- (`wl` param, see BookedPage.tsx / the checkout route's `stillWaitlisted`),
-- it just never receives a count from these two direct (non-Stripe) paths.
--
-- Both functions now report the party's *best* outcome — 'confirmed' (or,
-- for redeem_package_credit whose seats are always fully settled up front,
-- there's no 'pending' state to prefer) as soon as any seat got in, only
-- falling back to 'waitlisted' when NOTHING did — plus a `waitlisted_count`
-- column so the caller can tell the parent how many seats are still queued.
--
-- Idempotent (drop + recreate since the return type changes).

begin;

drop function if exists public.redeem_package_credit(uuid, uuid, uuid, uuid[], text, int, text, text, text[]);

create or replace function public.redeem_package_credit(
  p_purchase_id uuid,
  p_session_id uuid,
  p_child_id uuid default null,
  p_policies uuid[] default '{}',
  p_wix_booking_id text default null,
  p_quantity int default 1,
  p_medical text default null,
  p_info text default null,
  p_guest_names text[] default '{}'
)
returns table (status text, waitlisted_count int)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_user uuid := auth.uid();
  v_pur public.package_purchases;
  v_pkg public.packages;
  v_session record;
  v_booking_id uuid;
  v_this_status text;
  v_any_confirmed boolean := false;
  v_waitlisted_count int := 0;
  v_child uuid;
  v_group uuid := case when p_quantity > 1 then gen_random_uuid() else null end;
  v_i int;
begin
  if v_user is null then
    raise exception 'Please log in again to use this package credit';
  end if;
  if p_quantity < 1 then
    raise exception 'Choose at least one child to book for';
  end if;

  select * into v_pur
  from public.package_purchases
  where id = p_purchase_id
    and user_id = v_user
    and status = 'active'
    and credits_remaining >= p_quantity
    and (expires_at is null or expires_at > now());
  if not found then
    raise exception 'You are not able to use this package to book this class.';
  end if;

  select * into v_pkg from public.packages where id = v_pur.package_id;
  if not found then
    raise exception 'This package is no longer available — please contact support';
  end if;

  select s.id, s.starts_at, s.activity_id, a.provider_id
    into v_session
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  where s.id = p_session_id;
  if not found then
    raise exception 'That class time is no longer available — please pick another';
  end if;

  if v_session.provider_id is null or v_session.provider_id <> v_pur.provider_id then
    raise exception 'This package can only be used for its provider''s classes';
  end if;
  if v_pkg.activity_ids is not null and array_length(v_pkg.activity_ids, 1) > 0
     and not (v_session.activity_id = any(v_pkg.activity_ids)) then
    raise exception 'This package is limited to specific classes';
  end if;
  if v_pkg.allowed_weekday is not null
     and extract(dow from v_session.starts_at at time zone 'Asia/Singapore') <> v_pkg.allowed_weekday then
    raise exception 'This package can only be redeemed for its designated weekly slot';
  end if;
  if v_pkg.allowed_start_time is not null
     and (v_session.starts_at at time zone 'Asia/Singapore')::time <> v_pkg.allowed_start_time then
    raise exception 'This package can only be redeemed for its designated weekly slot';
  end if;

  select c.id into v_child
  from public.children c
  where c.parent_id = v_user
    and (p_child_id is null or c.id = p_child_id)
  order by c.created_at
  limit 1;
  if p_child_id is not null and v_child is null then
    raise exception 'That child is no longer on your profile — pick another';
  end if;

  for v_i in 1..p_quantity loop
    insert into public.bookings (
      user_id, session_id, child_id, guest_name, package_purchase_id, policies_accepted, wix_booking_id,
      medical_disclosure, info_response, booking_group_id
    )
    values (
      v_user,
      p_session_id,
      case when v_i = 1 then v_child else null end,
      case when v_i = 1 then null
           else coalesce(nullif(btrim(p_guest_names[v_i - 1]), ''), 'Guest child') end,
      p_purchase_id,
      coalesce(p_policies, '{}'::uuid[]),
      p_wix_booking_id,
      case when v_i = 1 then nullif(btrim(p_medical), '') else null end,
      case when v_i = 1 then nullif(btrim(p_info), '') else null end,
      v_group
    )
    returning id, status into v_booking_id, v_this_status;

    if v_this_status = 'pending' then
      update public.bookings set status = 'confirmed' where id = v_booking_id;
      v_this_status := 'confirmed';
    end if;
    if v_this_status = 'waitlisted' then
      v_waitlisted_count := v_waitlisted_count + 1;
    else
      v_any_confirmed := true;
    end if;
  end loop;

  update public.package_purchases
  set credits_remaining = credits_remaining - p_quantity,
      status = case when credits_remaining - p_quantity <= 0 then 'used' else status end
  where id = p_purchase_id;

  return query select (case when v_any_confirmed then 'confirmed' else 'waitlisted' end), v_waitlisted_count;
end;
$function$;

grant execute on function public.redeem_package_credit(uuid, uuid, uuid, uuid[], text, int, text, text, text[]) to authenticated;

drop function if exists public.book_party(uuid, uuid, text[], uuid[], text, text);

create or replace function public.book_party(
  p_session_id  uuid,
  p_child_id    uuid default null,
  p_guest_names text[] default '{}',
  p_policies    uuid[] default '{}',
  p_medical     text default null,
  p_info        text default null
)
returns table (group_id uuid, status text, waitlisted_count int)
language plpgsql
security definer
set search_path to 'public'
as $function$
#variable_conflict use_column
declare
  v_user          uuid := auth.uid();
  v_seats         int  := 1 + coalesce(array_length(p_guest_names, 1), 0);
  v_group         uuid := gen_random_uuid();
  v_session       record;
  v_child         uuid;
  v_status        text;
  v_id            uuid;
  v_i             int;
  v_any_pending   boolean := false;
  v_any_confirmed boolean := false;
  v_waitlisted_count int := 0;
  v_ret           text;
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
      v_waitlisted_count := v_waitlisted_count + 1;
    elsif v_status = 'pending' then
      v_any_pending := true;
    elsif v_status = 'confirmed' then
      v_any_confirmed := true;
    end if;
  end loop;

  -- Return contract read by the parent app (see file header): prefer
  -- 'pending' (something needs paying, send the party to Stripe), else
  -- 'confirmed' as soon as any seat is genuinely in, only 'waitlisted' when
  -- nothing fit at all. waitlisted_count is the leftover for the caller to
  -- show alongside a non-'waitlisted' status.
  if v_any_pending then
    v_ret := 'pending';
  elsif v_any_confirmed then
    v_ret := 'confirmed';
  else
    v_ret := 'waitlisted';
  end if;

  return query select v_group, v_ret, v_waitlisted_count;
end;
$function$;

grant execute on function public.book_party(uuid, uuid, text[], uuid[], text, text) to authenticated;

notify pgrst, 'reload schema';

commit;
