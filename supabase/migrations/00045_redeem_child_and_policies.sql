-- 00045_redeem_child_and_policies.sql
--
-- Follow-on from 00044. Two problems the new consent gate exposed in the two
-- RPCs that book a class without a plain INSERT:
--
--   1. `redeem_package_credit` hard-codes `child_id => null`. That is the real
--      reason the founder saw bookings as "Guest" on the vendor roster: a
--      class booked with a pack credit never recorded which child it was for,
--      so there was no name to show. It now takes the child.
--
--   2. Both RPCs insert a booking, so `booking_policy_gate` applies to them —
--      but they had no way to carry the consents the parent ticked, which
--      would have blocked every credit/token redemption at a provider that
--      uses waivers. Both now accept the accepted-policy ids.
--
-- Both new arguments are defaulted, so nothing that calls these with the old
-- two arguments breaks; the old two-argument signatures are dropped so the
-- call never becomes ambiguous.

drop function if exists public.redeem_package_credit(uuid, uuid);

create or replace function public.redeem_package_credit(
  p_purchase_id uuid,
  p_session_id uuid,
  p_child_id uuid default null,
  p_policies uuid[] default '{}'
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
  v_status text;
  v_child uuid;
begin
  if v_user is null then
    raise exception 'Not authenticated';
  end if;

  select * into v_pur
  from public.package_purchases
  where id = p_purchase_id
    and user_id = v_user
    and status = 'active'
    and credits_remaining > 0
    and (expires_at is null or expires_at > now());
  if not found then
    raise exception 'No credits available on this package (it may have expired)';
  end if;

  select * into v_pkg from public.packages where id = v_pur.package_id;

  select s.id, s.starts_at, s.activity_id, a.provider_id
    into v_session
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  where s.id = p_session_id;

  if v_session.provider_id is null or v_session.provider_id <> v_pur.provider_id then
    raise exception 'This package can only be used for its provider''s classes';
  end if;
  if v_pkg.activity_id is not null and v_pkg.activity_id <> v_session.activity_id then
    raise exception 'This package is limited to a specific class';
  end if;
  if v_pkg.allowed_weekday is not null
     and extract(dow from v_session.starts_at at time zone 'Asia/Singapore') <> v_pkg.allowed_weekday then
    raise exception 'This package can only be redeemed for its designated weekly slot';
  end if;
  if v_pkg.allowed_start_time is not null
     and (v_session.starts_at at time zone 'Asia/Singapore')::time <> v_pkg.allowed_start_time then
    raise exception 'This package can only be redeemed for its designated weekly slot';
  end if;

  -- Only the caller's own children, so a stray id can't attach a booking to
  -- someone else's child. Falls back to their only child when none is given,
  -- which is what the booking page shows anyway.
  select c.id into v_child
  from public.children c
  where c.parent_id = v_user
    and (p_child_id is null or c.id = p_child_id)
  order by c.created_at
  limit 1;

  insert into public.bookings (user_id, session_id, child_id, package_purchase_id, policies_accepted)
  values (v_user, p_session_id, v_child, p_purchase_id, coalesce(p_policies, '{}'::uuid[]))
  returning id, status into v_booking_id, v_status;

  -- A credit pays for the class, so a paid-class booking confirms immediately
  -- (capacity overflow still waitlists).
  if v_status = 'pending' then
    update public.bookings set status = 'confirmed' where id = v_booking_id;
    v_status := 'confirmed';
  end if;

  update public.package_purchases
  set credits_remaining = credits_remaining - 1,
      status = case when credits_remaining - 1 <= 0 then 'used' else status end
  where id = p_purchase_id;

  return v_status;
end;
$function$;

grant execute on function public.redeem_package_credit(uuid, uuid, uuid, uuid[]) to authenticated;

drop function if exists public.redeem_make_up_token(uuid, uuid);

create or replace function public.redeem_make_up_token(
  p_token_id uuid,
  p_session_id uuid,
  p_policies uuid[] default '{}'
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

  select * into v_tok
  from public.make_up_tokens
  where id = p_token_id
    and user_id = v_user
    and status = 'issued'
    and (expires_at is null or expires_at > now());
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

  insert into public.bookings (user_id, session_id, child_id, policies_accepted)
  values (v_user, p_session_id, v_tok.child_id, coalesce(p_policies, '{}'::uuid[]))
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

grant execute on function public.redeem_make_up_token(uuid, uuid, uuid[]) to authenticated;

notify pgrst, 'reload schema';
