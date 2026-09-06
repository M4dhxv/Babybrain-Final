-- 00084_multi_child_booking_group.sql
--
-- Booking "N children" on one class used to fan out into N standalone
-- booking rows the parent's My Bookings page then rendered as N identical
-- cards (the redeem_package_credit loop), while the native cash path
-- silently booked and charged for one. This makes a party ONE thing:
--
--   * every seat is still its own bookings row (capacity, roster,
--     attendance, per-seat credit/token compensation all stay per-row),
--   * but the rows share a booking_group_id, so the parent app collapses
--     them into a single card ("3 children") and cancels/reschedules them
--     together,
--   * seat 1 carries the chosen child; seats 2..N have child_id = null and
--     show as "Guest child" on both the parent card and the vendor roster
--     until the parent renames them (rename_booking_guest, below), which
--     writes bookings.guest_name — the column the roster already coalesces.
--
-- New:
--   bookings.booking_group_id  uuid, null for a solo booking
--   book_party()               native (cash/free) path, all-or-nothing on capacity
--   cancel_booking_group()     whole-party cancel (treatment 1)
--   rename_booking_guest()     parent edits a guest seat's name
--   redeem_package_credit()    gains p_guest_names; stamps a shared group id
--
-- Idempotent.

begin;

-- ---------------------------------------------------------------------------
-- Column
-- ---------------------------------------------------------------------------
alter table public.bookings
  add column if not exists booking_group_id uuid;

comment on column public.bookings.booking_group_id is
  'Groups the seat rows of one multi-child booking (00084). Null = a solo '
  'booking. The parent app renders one card per group and cancels/reschedules '
  'the group as a unit; each row is still an independent seat for capacity, '
  'roster and cancellation compensation.';

create index if not exists bookings_group_idx
  on public.bookings (booking_group_id)
  where booking_group_id is not null;

-- ---------------------------------------------------------------------------
-- book_party() — the native (non-package, non-token) booking path.
--
-- Replaces the client's single raw insert. Inserts one row per seat inside
-- one transaction, all sharing a fresh group id, and refuses the whole
-- party up front if the session can't seat it (all-or-nothing: no
-- half-waitlisted parties). Paid classes come back 'pending' for every
-- seat — /api/bookings/checkout charges quantity = seat count and the
-- Stripe webhook confirms the whole group.
-- ---------------------------------------------------------------------------
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
declare
  v_user     uuid := auth.uid();
  v_seats    int  := 1 + coalesce(array_length(p_guest_names, 1), 0);
  v_group    uuid := gen_random_uuid();
  v_session  record;
  v_child    uuid;
  v_capacity int;
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

  -- All-or-nothing capacity: count live seats already on the session and
  -- make sure the whole party fits. A null capacity means unlimited.
  if v_session.capacity is not null then
    -- Same live-seat filter handle_booking_insert uses for its per-row check.
    select count(*) into v_taken
    from public.bookings
    where session_id = p_session_id
      and status in ('pending', 'confirmed');
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
      -- Extra seats always carry a name so the vendor roster shows "Guest
      -- child" rather than falling through to the parent's own name.
      case when v_i = 1 then null
           else coalesce(nullif(btrim(p_guest_names[v_i - 1]), ''), 'Guest child') end,
      coalesce(p_policies, '{}'::uuid[]),
      case when v_i = 1 then nullif(btrim(p_medical), '') else null end,
      case when v_i = 1 then nullif(btrim(p_info), '') else null end,
      v_group
    )
    returning id, status into v_id, v_status;

    -- Report the strongest state across the party: waitlisted > pending
    -- (paid, awaiting Stripe) > confirmed.
    if v_status = 'waitlisted' then
      v_worst := 'waitlisted';
    elsif v_status = 'pending' and v_worst <> 'waitlisted' then
      v_worst := 'pending';
    end if;
  end loop;

  return query select v_group, v_worst;
end;
$function$;

grant execute on function public.book_party(uuid, uuid, text[], uuid[], text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- cancel_booking_group() — cancel every seat in a party at once.
--
-- Runs the same policy checks cancel_booking does (allow_cancellation +
-- cutoff), then flips every still-live seat the caller owns to 'cancelled'.
-- The per-row compensate_cancelled_booking trigger then returns one credit
-- or issues one make-up token per seat, exactly as for single cancels.
-- ---------------------------------------------------------------------------
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

  select a.allow_cancellation, a.cancellation_cutoff_hours, s.starts_at
    into v_allow, v_cutoff, v_starts
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
  set status = 'cancelled'
  where booking_group_id = p_group_id
    and user_id = v_user
    and status in ('pending', 'confirmed', 'waitlisted');
end;
$function$;

grant execute on function public.cancel_booking_group(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- rename_booking_guest() — parent edits the name of a guest seat.
--
-- Only a guest seat (child_id is null) on the caller's own booking, and only
-- the guest_name column. Passing null / blank resets it to "Guest child".
-- ---------------------------------------------------------------------------
create or replace function public.rename_booking_guest(p_booking_id uuid, p_name text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_user uuid := auth.uid();
  v_clean text := nullif(btrim(p_name), '');
begin
  if v_user is null then raise exception 'Not authenticated'; end if;

  update public.bookings
  set guest_name = coalesce(left(v_clean, 80), 'Guest child')
  where id = p_booking_id
    and user_id = v_user
    and child_id is null;
  if not found then
    raise exception 'That place could not be updated.';
  end if;
end;
$function$;

grant execute on function public.rename_booking_guest(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- redeem_package_credit() — gains p_guest_names and a shared group id.
--
-- Same as 00079 plus: when more than one seat is booked, the rows share a
-- booking_group_id, seat 1 keeps the chosen child, and seats 2..N have
-- child_id = null with guest_name from p_guest_names (blank -> "Guest child"
-- via the app's own fallback).
-- ---------------------------------------------------------------------------
drop function if exists public.redeem_package_credit(uuid, uuid, uuid, uuid[], text, int, text, text);

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
returns text
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
  v_worst_status text := 'confirmed';
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
    raise exception 'Not enough credits available on this package (it may have expired)';
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
      v_worst_status := 'waitlisted';
    end if;
  end loop;

  update public.package_purchases
  set credits_remaining = credits_remaining - p_quantity,
      status = case when credits_remaining - p_quantity <= 0 then 'used' else status end
  where id = p_purchase_id;

  return v_worst_status;
end;
$function$;

grant execute on function public.redeem_package_credit(uuid, uuid, uuid, uuid[], text, int, text, text, text[]) to authenticated;

-- ---------------------------------------------------------------------------
-- enforce_booking_insert_defaults() — companion seats skip the info-answer
-- gate.
--
-- A multi-child booking's guest seats (guest_name set, no child) carry no
-- info_response — the vendor's booking question is answered once, on the
-- primary seat. Verbatim copy of the 00074 body with one added clause on the
-- info gate, mirroring how enforce_booking_policies (00044) already skips a
-- guest_name row.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_booking_insert_defaults()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_price numeric;
  v_paused boolean;
  v_provider uuid;
  v_is_manager boolean := false;
  v_starts_at timestamptz;
  v_cutoff int;
  v_info_enabled boolean;
begin
  if coalesce(auth.role(), '') = 'service_role' then
    return new;  -- trusted server path (Stripe webhook) sets its own state
  end if;

  select coalesce(s.price, a.price), a.bookings_paused, a.provider_id,
         s.starts_at, a.booking_cutoff_minutes, a.info_request_enabled
    into v_price, v_paused, v_provider,
         v_starts_at, v_cutoff, v_info_enabled
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  where s.id = new.session_id;

  v_is_manager := v_provider in (select public.user_manage_provider_ids());

  if coalesce(v_paused, false) and not v_is_manager then
    raise exception 'Bookings for this class are currently paused.';
  end if;

  if not v_is_manager
     and v_starts_at is not null
     and v_starts_at - make_interval(mins => coalesce(v_cutoff, 15)) <= now() then
    if coalesce(v_cutoff, 15) = 0 then
      raise exception 'This class has already started.';
    end if;
    raise exception 'Bookings for this class close % minutes before it starts.', coalesce(v_cutoff, 15);
  end if;

  -- 1.3 (00074): the vendor's booking question must be answered — except on a
  -- companion seat of a multi-child booking (00084), where it rode in on the
  -- primary seat.
  if coalesce(v_info_enabled, false) and not v_is_manager
     and coalesce(new.guest_name, '') = ''
     and coalesce(btrim(new.info_response), '') = '' then
    raise exception 'This class needs some extra information before you can book.';
  end if;

  new.amount := null;
  new.stripe_payment_intent := null;

  if v_is_manager and new.guest_name is not null then
    if new.payment_status is null or new.payment_status not in ('none', 'paid') then
      new.payment_status := 'none';
    end if;
    if new.status is distinct from 'waitlisted' then
      new.status := 'confirmed';
      new.waitlist_position := null;
    end if;
  else
    new.payment_status := 'none';
    if new.status = 'waitlisted' then
      null;
    else
      new.waitlist_position := null;
      if coalesce(v_price, 0) = 0 then
        new.status := 'confirmed';
      else
        new.status := 'pending';
      end if;
    end if;
  end if;
  return new;
end;
$$;

commit;
