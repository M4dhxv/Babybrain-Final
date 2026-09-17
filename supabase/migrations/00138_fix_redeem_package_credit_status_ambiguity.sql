-- 00138_fix_redeem_package_credit_status_ambiguity.sql
--
-- 00136 changed redeem_package_credit's return type from `returns text` to
-- `returns table (status text, waitlisted_count int)` so it could report a
-- party's waitlisted_count alongside its status. For a TABLE-returning
-- PL/pgSQL function, each output column also becomes an implicitly declared
-- variable in the function body — so `status` is now BOTH an output variable
-- AND a column of `public.bookings`.
--
-- Nothing else in the function body got updated for that. Three bare
-- `status` references are ambiguous as a result:
--   1. The very first statement — `select * into v_pur from
--      public.package_purchases where id = ... and status = 'active' ...` —
--      is unqualified, so it fires on EVERY call before anything else runs.
--   2. The per-seat insert loop's `returning id, status into v_booking_id,
--      v_this_status` is the same shape of bug one loop iteration later.
--   3. The credits-decrement update's `status = case when ... then 'used'
--      else status end` reads the column's current value back through the
--      same bare name in its ELSE branch (the assignment target on the left
--      of `=` is fine — only a column can go there — but that `else status`
--      on the right is a plain expression, so it's ambiguous too).
-- Any one of the three is enough for Postgres to raise 42702 "column
-- reference \"status\" is ambiguous" on EVERY call, for EVERY activity, the
-- moment a parent redeems a package credit on the native (non-Wix) booking
-- path. 42702 isn't P0001, so the parent app's
-- cleanRpcErrorMessage (frontends/parent/src/lib/errors.ts) treats it as an
-- internal error and shows the generic "Something went wrong" line instead
-- of the real cause — which is why it looked like a mysterious, unexplained,
-- always-reproducing failure rather than a normal validation message. The
-- credit itself is never actually spent: the whole function call is one
-- transaction, so the failed RETURNING aborts it before the
-- package_purchases update runs, which is why retrying always shows the same
-- "N credits left".
--
-- book_party (also redefined in 00136) never hit this because its own
-- RETURNING clause already qualifies the column: `returning bookings.id,
-- bookings.status into v_id, v_status`. Same fix here.
--
-- Same body as 00136, only the three `status` references above are qualified.

begin;

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
  from public.package_purchases pp
  where pp.id = p_purchase_id
    and pp.user_id = v_user
    and pp.status = 'active'
    and pp.credits_remaining >= p_quantity
    and (pp.expires_at is null or pp.expires_at > now());
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

notify pgrst, 'reload schema';

commit;
