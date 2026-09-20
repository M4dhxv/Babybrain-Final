-- 00156_fix_critical_races_and_trust.sql
--
-- Four fixes from a full-codebase bug audit (2026-09-20), all confirmed by
-- tracing real code paths against real data, not just pattern-matched:
--
-- 1. bookings.provider_id was trusted from the client insert. The RLS policy
--    "managers add manual bookings" only checks the caller manages the
--    provider_id THEY SUPPLY — never that it matches the session they're
--    actually booking. handle_booking_insert() only filled provider_id via
--    COALESCE when null, so a caller could supply session_id belonging to a
--    DIFFERENT provider's class alongside their own provider_id: a real seat
--    in that other provider's class gets consumed, capacity is decremented
--    against them, but the booking is invisible on their own dashboard.
--    provider_id is now always derived from session_id, never trusted.
--
-- 2. The same trigger's capacity check (count bookings, compare to capacity)
--    had no row lock. Two concurrent inserts for a session's last open seat
--    could both read "under capacity" under READ COMMITTED and both
--    succeed, overselling the class. Now locks the session row first, so
--    concurrent inserts for the same session serialize.
--
-- 3. redeem_package_credit() and redeem_make_up_token() checked eligibility
--    (credits_remaining >= n / status = 'issued') without locking the row,
--    so two concurrent redemptions of the last credit/token could both pass
--    the check before either committed its decrement — double-spending one
--    credit into two real bookings. Both selects now lock the row.
--
-- 4. provider_earnings' money columns and package_purchases.credits_remaining
--    had no CHECK >= 0, unlike subscriptions.commission_rate which got one
--    in the same migration that created it (00051). Defense in depth against
--    #3 recurring in some other form, or any future bug in the split math.
--    No existing rows violate this (checked before writing this migration).
--
-- Idempotent.

begin;

-- 1 & 2 -------------------------------------------------------------------
create or replace function public.handle_booking_insert()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_capacity int;
  v_taken int;
  v_provider uuid;
  v_wix_type text;
begin
  -- Lock the session row for the rest of this transaction so a concurrent
  -- insert for the same session_id has to wait here rather than racing the
  -- capacity count below against a value this transaction hasn't committed
  -- yet. `for update of s` only locks activity_sessions, not activities.
  select a.provider_id, s.capacity, a.wix_service_type
    into v_provider, v_capacity, v_wix_type
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  where s.id = new.session_id
  for update of s;

  -- Always the session's real owner. bookings.session_id is NOT NULL and
  -- every insert path (book_party, redeem_package_credit,
  -- redeem_make_up_token, manual bookings) already supplies a real session,
  -- so there is no legitimate case where the caller's own provider_id should
  -- win over what the session actually belongs to.
  new.provider_id := v_provider;

  -- Wix Events and Wix COURSE enrolments have no local waitlist — Wix owns
  -- their remaining capacity and the booking only reaches here once Wix has
  -- already accepted it. Leave the incoming status untouched.
  if v_capacity is not null and coalesce(v_wix_type, '') not in ('EVENT', 'COURSE') then
    select count(*) into v_taken from public.bookings
    where session_id = new.session_id and status in ('pending','confirmed');
    if v_taken >= v_capacity then
      new.status := 'waitlisted';
      select coalesce(max(waitlist_position), 0) + 1 into new.waitlist_position
      from public.bookings where session_id = new.session_id and status = 'waitlisted';
    end if;
  end if;
  return new;
end;
$$;

-- 3 -------------------------------------------------------------------------
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

  -- Locked: two concurrent redemptions of the same pack's last credit(s)
  -- must not both pass this check before either commits its decrement.
  select * into v_pur
  from public.package_purchases pp
  where pp.id = p_purchase_id
    and pp.user_id = v_user
    and pp.status = 'active'
    and pp.credits_remaining >= p_quantity
    and (pp.expires_at is null or pp.expires_at > now())
  for update;
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
    returning bookings.id, bookings.status into v_booking_id, v_this_status;

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
      status = case when credits_remaining - p_quantity <= 0 then 'used' else package_purchases.status end
  where id = p_purchase_id;

  return query select (case when v_any_confirmed then 'confirmed' else 'waitlisted' end), v_waitlisted_count;
end;
$function$;

grant execute on function public.redeem_package_credit(uuid, uuid, uuid, uuid[], text, int, text, text, text[]) to authenticated;

create or replace function public.redeem_make_up_token(
  p_token_id uuid,
  p_session_id uuid,
  p_policies uuid[] default '{}',
  p_medical text default null,
  p_info text default null
)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_user uuid := auth.uid();
  v_tok public.make_up_tokens;
  v_provider uuid;
  v_booking_id uuid;
  v_status text;
begin
  if v_user is null then
    raise exception 'Not authenticated';
  end if;

  -- Locked: two concurrent redemptions of the same token must not both pass
  -- this check before either commits its status update.
  select * into v_tok
  from public.make_up_tokens
  where id = p_token_id
    and user_id = v_user
    and status = 'issued'
    and (expires_at is null or expires_at > now())
  for update;
  if not found then
    raise exception 'This make-up token is not available';
  end if;

  select a.provider_id into v_provider
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  where s.id = p_session_id;
  if v_provider is null or v_provider <> v_tok.provider_id then
    raise exception 'This token can only be used for its provider''s classes';
  end if;

  insert into public.bookings (user_id, session_id, child_id, policies_accepted, medical_disclosure, info_response)
  values (
    v_user, p_session_id, v_tok.child_id, coalesce(p_policies, '{}'::uuid[]),
    nullif(btrim(p_medical), ''), nullif(btrim(p_info), '')
  )
  returning id, status into v_booking_id, v_status;

  if v_status = 'pending' then
    update public.bookings set status = 'confirmed' where id = v_booking_id;
    v_status := 'confirmed';
  end if;

  update public.make_up_tokens
  set status = 'redeemed', redeemed_booking_id = v_booking_id
  where id = p_token_id;

  return v_status;
end;
$function$;

grant execute on function public.redeem_make_up_token(uuid, uuid, uuid[], text, text) to authenticated;

-- 4 -------------------------------------------------------------------------
alter table public.package_purchases drop constraint if exists package_purchases_credits_remaining_check;
alter table public.package_purchases add constraint package_purchases_credits_remaining_check
  check (credits_remaining >= 0);

alter table public.provider_earnings drop constraint if exists provider_earnings_gross_cents_check;
alter table public.provider_earnings add constraint provider_earnings_gross_cents_check
  check (gross_cents >= 0);
alter table public.provider_earnings drop constraint if exists provider_earnings_commission_cents_check;
alter table public.provider_earnings add constraint provider_earnings_commission_cents_check
  check (commission_cents >= 0);
alter table public.provider_earnings drop constraint if exists provider_earnings_net_cents_check;
alter table public.provider_earnings add constraint provider_earnings_net_cents_check
  check (net_cents >= 0);

notify pgrst, 'reload schema';

commit;
