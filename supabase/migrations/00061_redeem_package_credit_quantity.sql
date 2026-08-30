-- The booking page's "Number of children" count (1-6) was purely cosmetic
-- for the credit path: it scaled the displayed single-class price, but
-- redeeming a credit always consumed exactly 1 credit and filled exactly 1
-- spot regardless of how many children were selected. New optional
-- p_quantity (default 1, so every existing call site is unaffected) checks
-- for that many credits up front and inserts that many booking rows — one
-- per seat — in the same transaction as the credit decrement, so a partial
-- failure can't deduct credits without creating the matching bookings.

drop function if exists public.redeem_package_credit(uuid, uuid, uuid, uuid[], text);

create or replace function public.redeem_package_credit(
  p_purchase_id uuid,
  p_session_id uuid,
  p_child_id uuid default null,
  p_policies uuid[] default '{}',
  p_wix_booking_id text default null,
  p_quantity int default 1
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
  v_i int;
begin
  if v_user is null then
    raise exception 'Not authenticated';
  end if;
  if p_quantity < 1 then
    raise exception 'quantity must be at least 1';
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

  for v_i in 1..p_quantity loop
    insert into public.bookings (user_id, session_id, child_id, package_purchase_id, policies_accepted, wix_booking_id)
    values (v_user, p_session_id, v_child, p_purchase_id, coalesce(p_policies, '{}'::uuid[]), p_wix_booking_id)
    returning id, status into v_booking_id, v_this_status;

    -- A credit pays for the class, so a paid-class booking confirms
    -- immediately (capacity overflow still waitlists — that's untouched).
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

grant execute on function public.redeem_package_credit(uuid, uuid, uuid, uuid[], text, int) to authenticated;
