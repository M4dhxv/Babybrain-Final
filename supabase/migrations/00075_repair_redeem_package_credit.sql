-- Repair: 00068 half-applied in production.
--
-- 00068 widened packages.activity_id (uuid) to packages.activity_ids (uuid[])
-- and, in the same file, re-created redeem_package_credit to match. In
-- production only the DDL landed — `packages` has `activity_ids` and no
-- `activity_id`, but the function body was still 00061's, referencing
-- `v_pkg.activity_id`. A rowtype variable resolves its fields at *runtime*,
-- so the mismatch could not fail until a parent actually redeemed a credit,
-- and then surfaced as the raw Postgres error
--     record "v_pkg" has no field "activity_id"
-- on the checkout screen. Every package-credit redemption on a non-Wix
-- ("site native") activity was broken; the Wix path hit the same function but
-- its API route replaced the message, which is why only the native flow
-- showed the internal text.
--
-- Re-creating the function is the fix. The guards below are the robustness
-- pass: several failure modes were either silent or reported as a misleading
-- message. The final block turns a half-apply from a latent runtime error
-- into an immediate, loud migration failure.

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

  -- Was unguarded: a purchase pointing at a deleted package left v_pkg null,
  -- so every restriction check below silently passed and the credit was spent
  -- on a class the pack may never have covered.
  select * into v_pkg from public.packages where id = v_pur.package_id;
  if not found then
    raise exception 'This package is no longer available — please contact support';
  end if;

  select s.id, s.starts_at, s.activity_id, a.provider_id
    into v_session
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  where s.id = p_session_id;
  -- Was folded into the provider check below, so a stale or removed session
  -- was reported as "can only be used for its provider's classes" — true but
  -- misleading, and it sent parents to the wrong support question.
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
  -- A p_child_id that isn't this parent's matched nothing and fell through as
  -- null, re-creating the "Guest on the vendor roster" bug 00061 set out to
  -- fix. Only an explicitly-passed child is validated; passing null still
  -- means "default to the first child", and no children at all stays allowed.
  if p_child_id is not null and v_child is null then
    raise exception 'That child is no longer on your profile — pick another';
  end if;

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

-- Self-check. The whole incident was this file's two halves disagreeing while
-- both looked applied, so assert they agree before this migration is called
-- done: the packages table and the live function body must be on the same
-- column. Cheap, and it fails at deploy time instead of at a parent's
-- checkout.
do $check$
declare
  v_has_ids boolean;
  v_src text;
begin
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'packages' and column_name = 'activity_ids'
  ) into v_has_ids;
  if not v_has_ids then
    raise exception 'packages.activity_ids is missing — apply 00068 before this migration';
  end if;

  select p.prosrc into v_src
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'redeem_package_credit';
  if v_src is null then
    raise exception 'redeem_package_credit did not get created';
  end if;
  if position('v_pkg.activity_ids' in v_src) = 0 then
    raise exception 'redeem_package_credit is still on the dropped activity_id column';
  end if;
end;
$check$;
