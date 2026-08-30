-- redeem_package_credit's INSERT never had a wix_booking_id column to set,
-- so a credit-redeemed Wix booking always landed with wix_booking_id null
-- even when app/api/wix/bookings/redeem-package had already created a real
-- booking in Wix and knew its id. New optional arg, defaulted to null so
-- every existing (non-Wix) call site is unaffected.

drop function if exists public.redeem_package_credit(uuid, uuid, uuid, uuid[]);

create or replace function public.redeem_package_credit(
  p_purchase_id uuid,
  p_session_id uuid,
  p_child_id uuid default null,
  p_policies uuid[] default '{}',
  p_wix_booking_id text default null
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

  select c.id into v_child
  from public.children c
  where c.parent_id = v_user
    and (p_child_id is null or c.id = p_child_id)
  order by c.created_at
  limit 1;

  insert into public.bookings (user_id, session_id, child_id, package_purchase_id, policies_accepted, wix_booking_id)
  values (v_user, p_session_id, v_child, p_purchase_id, coalesce(p_policies, '{}'::uuid[]), p_wix_booking_id)
  returning id, status into v_booking_id, v_status;

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

grant execute on function public.redeem_package_credit(uuid, uuid, uuid, uuid[], text) to authenticated;
