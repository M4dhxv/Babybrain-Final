-- 00079_redeem_medical_and_info.sql
--
-- redeem_package_credit and redeem_make_up_token carried `policies_accepted`
-- onto the booking they create but nothing else the booking form collects —
-- so a class booked with a package credit or a make-up token reached the
-- vendor roster with the waivers ticked but "Medical Disclosure: None
-- provided" and no answer to the vendor's info request, even when the parent
-- filled both. (It also meant a package-credit redemption of an
-- info_request_enabled class hit the enforce_booking_insert_defaults gate.)
--
-- Both functions gain optional p_medical / p_info text params, written onto
-- the bookings insert. The previous signatures are dropped first so the new
-- overload isn't ambiguous for callers that don't pass them.
--
-- Idempotent.

-- ---- redeem_package_credit ------------------------------------------------
drop function if exists public.redeem_package_credit(uuid, uuid);
drop function if exists public.redeem_package_credit(uuid, uuid, uuid, uuid[]);
drop function if exists public.redeem_package_credit(uuid, uuid, uuid, uuid[], text);
drop function if exists public.redeem_package_credit(uuid, uuid, uuid, uuid[], text, int);

create or replace function public.redeem_package_credit(
  p_purchase_id uuid,
  p_session_id uuid,
  p_child_id uuid default null,
  p_policies uuid[] default '{}',
  p_wix_booking_id text default null,
  p_quantity int default 1,
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
      user_id, session_id, child_id, package_purchase_id, policies_accepted, wix_booking_id,
      medical_disclosure, info_response
    )
    values (
      v_user, p_session_id, v_child, p_purchase_id, coalesce(p_policies, '{}'::uuid[]), p_wix_booking_id,
      nullif(btrim(p_medical), ''), nullif(btrim(p_info), '')
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

grant execute on function public.redeem_package_credit(uuid, uuid, uuid, uuid[], text, int, text, text) to authenticated;

-- ---- redeem_make_up_token -----------------------------------------------
drop function if exists public.redeem_make_up_token(uuid, uuid);
drop function if exists public.redeem_make_up_token(uuid, uuid, uuid[]);

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
