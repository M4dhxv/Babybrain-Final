-- 00270_admin_create_booking.sql
--
-- Admin → Bookings → "Create booking": book a customer into a class using a
-- class-pack credit, a make-up token, or as a manual (phone / walk-in) booking.
--
-- The parent-facing redeem_package_credit() / redeem_make_up_token() act as
-- auth.uid(), so an admin cannot call them for someone else. These two
-- functions are the admin equivalents, and they carry the SAFEGUARD:
--
--   admin_booking_checks()  one list of cross-checks, used by BOTH the
--                           "verify" step the admin sees and the create step.
--                           The headline check: the vendor that owns the
--                           credit / token must be the vendor that runs the
--                           class. It also checks the credit really belongs to
--                           that customer, is active / unexpired / has a
--                           balance, obeys the pack's class / weekday / time
--                           limits, and (for a token) that the booking it was
--                           issued for belonged to the same vendor.
--   admin_create_booking()  locks the session and the credit / token row,
--                           re-runs admin_booking_checks() inside the same
--                           transaction (so a stale screen or a hand-made API
--                           call cannot skip it), writes the booking, spends
--                           the credit / token, then READS IT BACK and raises
--                           (rolling everything back) unless exactly one
--                           credit / token was spent against this booking.
--
-- Credit / token bookings are refused for Wix-linked and term sessions (those
-- have their own booking paths) and for a full class (it would waitlist, and a
-- waitlisted seat spends nothing). Manual bookings may be added to a full
-- native session on request, the same way a vendor can (00196).
--
-- Service role only. Idempotent.

begin;

create or replace function public.admin_booking_checks(
  p_user_id uuid,
  p_session_id uuid,
  p_method text,
  p_purchase_id uuid default null,
  p_token_id uuid default null,
  p_child_id uuid default null,
  p_allow_over_capacity boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_checks   jsonb := '[]'::jsonb;
  v_ok       boolean := true;
  v_s        record;
  v_parent   record;
  v_child    record;
  v_pur      record;
  v_pkg      record;
  v_tok      record;
  v_origin   record;
  v_fund_provider uuid;
  v_fund_vendor   text;
  v_fund jsonb := 'null'::jsonb;
  v_taken int;
  v_dupe  int;
  v_wix   boolean;
  v_term  boolean;
  v_child_id uuid := p_child_id;
begin
  if p_method not in ('credit', 'token', 'manual') then
    return jsonb_build_object('ok', false, 'checks', jsonb_build_array(jsonb_build_object(
      'key', 'method', 'label', 'Booking type', 'ok', false, 'detail', 'Choose credit, make-up token or manual booking.')));
  end if;

  -- ---- the class ----------------------------------------------------------
  select s.id, s.starts_at, s.capacity, s.activity_id, s.wix_slot_key,
         to_jsonb(s)->>'term_slot_id' as term_slot_id,
         a.title, a.provider_id, a.wix_service_id, a.wix_service_type, a.wix_event_id,
         pr.business_name as vendor, pr.status as provider_status
    into v_s
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  left join public.providers pr on pr.id = a.provider_id
  where s.id = p_session_id;

  if not found then
    return jsonb_build_object('ok', false, 'checks', jsonb_build_array(jsonb_build_object(
      'key', 'class', 'label', 'Class found', 'ok', false, 'detail', 'That class time no longer exists.')));
  end if;

  v_checks := v_checks || jsonb_build_object('key', 'class', 'label', 'Class found', 'ok', true,
    'detail', coalesce(v_s.title, 'Class') || ' · ' || coalesce(v_s.vendor, 'no vendor'));

  v_checks := v_checks || jsonb_build_object('key', 'upcoming', 'label', 'Class has not started', 'ok', v_s.starts_at > now(),
    'detail', case when v_s.starts_at > now() then 'Starts ' || to_char(v_s.starts_at at time zone 'Asia/Singapore', 'Dy DD Mon, HH12:MI AM')
                   else 'This class has already started.' end);

  v_checks := v_checks || jsonb_build_object('key', 'vendor_active', 'label', 'Vendor is taking bookings',
    'ok', coalesce(v_s.provider_status, 'active') = 'active',
    'detail', case when coalesce(v_s.provider_status, 'active') = 'active' then coalesce(v_s.vendor, 'Vendor') || ' is active'
                   else coalesce(v_s.vendor, 'This vendor') || ' is ' || v_s.provider_status || ', not active.' end);

  -- ---- capacity -----------------------------------------------------------
  if v_s.capacity is not null then
    select count(*) into v_taken from public.bookings b
    where b.session_id = p_session_id and b.status in ('pending', 'confirmed');
    if v_taken >= v_s.capacity then
      if p_method = 'manual' and p_allow_over_capacity then
        v_wix := v_s.wix_slot_key is not null or v_s.wix_service_id is not null
                 or v_s.wix_service_type is not null or v_s.wix_event_id is not null;
        v_checks := v_checks || jsonb_build_object('key', 'capacity', 'label', 'Seat available', 'ok', not v_wix,
          'detail', case when v_wix then 'This class is full and its capacity is managed on Wix, so it cannot be raised here.'
                         else 'Class is full (' || v_taken || ' of ' || v_s.capacity || '). Capacity will be raised by one for this booking.' end);
      else
        v_checks := v_checks || jsonb_build_object('key', 'capacity', 'label', 'Seat available', 'ok', false,
          'detail', 'Class is full (' || v_taken || ' of ' || v_s.capacity || ').'
                    || case when p_method = 'manual' then ' Tick "Add even though the class is full" to raise capacity by one.'
                            else ' A full class would put the customer on the waitlist and spend nothing.' end);
      end if;
    else
      v_checks := v_checks || jsonb_build_object('key', 'capacity', 'label', 'Seat available', 'ok', true,
        'detail', (v_s.capacity - v_taken) || ' of ' || v_s.capacity || ' seats left');
    end if;
  end if;

  -- ---- manual booking stops here (no customer account, nothing to spend) ---
  if p_method = 'manual' then
    select bool_and((c->>'ok')::boolean) into v_ok from jsonb_array_elements(v_checks) c;
    return jsonb_build_object(
      'ok', coalesce(v_ok, false), 'checks', v_checks,
      'class', jsonb_build_object('title', v_s.title, 'vendor', v_s.vendor, 'vendor_id', v_s.provider_id, 'starts_at', v_s.starts_at),
      'funding', null);
  end if;

  -- ---- credits and tokens: booking paths that live elsewhere --------------
  v_wix := v_s.wix_slot_key is not null or v_s.wix_service_id is not null
           or v_s.wix_service_type is not null or v_s.wix_event_id is not null;
  v_term := v_s.term_slot_id is not null;
  v_checks := v_checks || jsonb_build_object('key', 'path', 'label', 'Can be booked from here', 'ok', not v_wix and not v_term,
    'detail', case when v_wix then 'This class is linked to Wix. Book it through the customer''s app so Wix is updated too.'
                   when v_term then 'This class belongs to a term. Use the term enrolment tools instead.'
                   else 'Native BabyBrain class' end);

  -- ---- the customer -------------------------------------------------------
  select pp.id, pp.full_name, pp.email into v_parent from public.parent_profiles pp where pp.id = p_user_id;
  v_checks := v_checks || jsonb_build_object('key', 'customer', 'label', 'Customer account found', 'ok', found,
    'detail', case when found then coalesce(nullif(v_parent.full_name, ''), v_parent.email) || ' · ' || v_parent.email
                   else 'No customer account with that id.' end);

  -- ---- the credit or token: the cross-check -------------------------------
  if p_method = 'credit' then
    select * into v_pur from public.package_purchases where id = p_purchase_id;
    if not found then
      v_checks := v_checks || jsonb_build_object('key', 'funding', 'label', 'Credit found', 'ok', false, 'detail', 'Choose one of the customer''s packs.');
    else
      select * into v_pkg from public.packages where id = v_pur.package_id;
      v_fund_provider := v_pur.provider_id;
      select business_name into v_fund_vendor from public.providers where id = v_fund_provider;
      v_fund := jsonb_build_object('kind', 'credit', 'label', coalesce(v_pkg.name, 'Package'), 'vendor', v_fund_vendor,
        'vendor_id', v_fund_provider, 'remaining', v_pur.credits_remaining, 'total', v_pur.credits_total, 'expires_at', v_pur.expires_at);

      v_checks := v_checks || jsonb_build_object('key', 'owner', 'label', 'Credit belongs to this customer', 'ok', v_pur.user_id = p_user_id,
        'detail', case when v_pur.user_id = p_user_id then 'Pack is in this customer''s account'
                       else 'This pack belongs to a different customer.' end);

      v_checks := v_checks || jsonb_build_object('key', 'vendor_match', 'label', 'Credit vendor matches the class vendor',
        'ok', v_fund_provider is not distinct from v_s.provider_id and v_pkg.provider_id is not distinct from v_s.provider_id,
        'detail', case when v_fund_provider is not distinct from v_s.provider_id and v_pkg.provider_id is not distinct from v_s.provider_id
                       then 'Both are ' || coalesce(v_s.vendor, 'the same vendor')
                       else 'Credit is from ' || coalesce(v_fund_vendor, 'another vendor') || ' but the class is run by ' || coalesce(v_s.vendor, 'another vendor') || '.' end);

      v_checks := v_checks || jsonb_build_object('key', 'active', 'label', 'Pack is active and not expired',
        'ok', v_pur.status = 'active' and (v_pur.expires_at is null or v_pur.expires_at > now()),
        'detail', case when v_pur.status <> 'active' then 'Pack status is "' || v_pur.status || '".'
                       when v_pur.expires_at is not null and v_pur.expires_at <= now() then 'Pack expired ' || to_char(v_pur.expires_at at time zone 'Asia/Singapore', 'DD Mon YYYY') || '.'
                       when v_pur.expires_at is null then 'Active, no expiry'
                       else 'Active until ' || to_char(v_pur.expires_at at time zone 'Asia/Singapore', 'DD Mon YYYY') end);

      v_checks := v_checks || jsonb_build_object('key', 'balance', 'label', 'Pack has a credit left', 'ok', v_pur.credits_remaining >= 1,
        'detail', v_pur.credits_remaining || ' of ' || v_pur.credits_total || ' credits left'
                  || case when v_pur.credits_remaining >= 1 then ' (will be ' || (v_pur.credits_remaining - 1) || ' after this booking)' else '' end);

      v_checks := v_checks || jsonb_build_object('key', 'pack_rules', 'label', 'Class is allowed by the pack',
        'ok', not (
               (v_pkg.activity_ids is not null and array_length(v_pkg.activity_ids, 1) > 0 and not (v_s.activity_id = any(v_pkg.activity_ids)))
            or (v_pkg.allowed_weekday is not null and extract(dow from v_s.starts_at at time zone 'Asia/Singapore') <> v_pkg.allowed_weekday)
            or (v_pkg.allowed_start_time is not null and (v_s.starts_at at time zone 'Asia/Singapore')::time <> v_pkg.allowed_start_time)),
        'detail', case
            when v_pkg.activity_ids is not null and array_length(v_pkg.activity_ids, 1) > 0 and not (v_s.activity_id = any(v_pkg.activity_ids))
              then 'This pack is limited to specific classes and this is not one of them.'
            when v_pkg.allowed_weekday is not null and extract(dow from v_s.starts_at at time zone 'Asia/Singapore') <> v_pkg.allowed_weekday
              then 'This pack can only be used on its designated weekday.'
            when v_pkg.allowed_start_time is not null and (v_s.starts_at at time zone 'Asia/Singapore')::time <> v_pkg.allowed_start_time
              then 'This pack can only be used for its designated start time.'
            else 'No class, weekday or time limit is broken' end);
    end if;
  else
    select * into v_tok from public.make_up_tokens where id = p_token_id;
    if not found then
      v_checks := v_checks || jsonb_build_object('key', 'funding', 'label', 'Make-up token found', 'ok', false, 'detail', 'Choose one of the customer''s make-up tokens.');
    else
      v_fund_provider := v_tok.provider_id;
      select business_name into v_fund_vendor from public.providers where id = v_fund_provider;
      v_fund := jsonb_build_object('kind', 'token', 'label', 'Make-up token', 'vendor', v_fund_vendor,
        'vendor_id', v_fund_provider, 'remaining', case when v_tok.status = 'issued' then 1 else 0 end, 'total', 1, 'expires_at', v_tok.expires_at);
      v_child_id := coalesce(v_tok.child_id, p_child_id);

      v_checks := v_checks || jsonb_build_object('key', 'owner', 'label', 'Token belongs to this customer', 'ok', v_tok.user_id = p_user_id,
        'detail', case when v_tok.user_id = p_user_id then 'Token is in this customer''s account'
                       else 'This token belongs to a different customer.' end);

      v_checks := v_checks || jsonb_build_object('key', 'vendor_match', 'label', 'Token vendor matches the class vendor',
        'ok', v_fund_provider is not distinct from v_s.provider_id,
        'detail', case when v_fund_provider is not distinct from v_s.provider_id then 'Both are ' || coalesce(v_s.vendor, 'the same vendor')
                       else 'Token is from ' || coalesce(v_fund_vendor, 'another vendor') || ' but the class is run by ' || coalesce(v_s.vendor, 'another vendor') || '.' end);

      v_checks := v_checks || jsonb_build_object('key', 'active', 'label', 'Token is unused and not expired',
        'ok', v_tok.status = 'issued' and (v_tok.expires_at is null or v_tok.expires_at > now()),
        'detail', case when v_tok.status <> 'issued' then 'Token status is "' || v_tok.status || '".'
                       when v_tok.expires_at is not null and v_tok.expires_at <= now() then 'Token expired ' || to_char(v_tok.expires_at at time zone 'Asia/Singapore', 'DD Mon YYYY') || '.'
                       when v_tok.expires_at is null then 'Unused, no expiry'
                       else 'Unused, valid until ' || to_char(v_tok.expires_at at time zone 'Asia/Singapore', 'DD Mon YYYY') end);

      -- Where the token came from must be the same vendor too. A token with no
      -- origin booking was issued by hand and has nothing to compare.
      if v_tok.origin_booking_id is not null then
        select b.provider_id, a.title into v_origin
        from public.bookings b
        left join public.activity_sessions os on os.id = b.session_id
        left join public.activities a on a.id = os.activity_id
        where b.id = v_tok.origin_booking_id;
        v_checks := v_checks || jsonb_build_object('key', 'token_origin', 'label', 'Token came from this vendor''s cancelled class',
          'ok', found and v_origin.provider_id is not distinct from v_tok.provider_id,
          'detail', case when not found then 'The booking this token was issued for no longer exists.'
                         when v_origin.provider_id is not distinct from v_tok.provider_id then 'Issued for a cancelled "' || coalesce(v_origin.title, 'class') || '"'
                         else 'The cancelled booking behind this token belongs to a different vendor.' end);
      end if;
    end if;
  end if;

  -- ---- child and duplicates ----------------------------------------------
  if v_child_id is not null then
    select c.id, c.name, c.parent_id into v_child from public.children c where c.id = v_child_id;
    v_checks := v_checks || jsonb_build_object('key', 'child', 'label', 'Child belongs to this customer',
      'ok', found and v_child.parent_id = p_user_id,
      'detail', case when not found then 'That child no longer exists.'
                     when v_child.parent_id = p_user_id then v_child.name
                     else 'That child is on a different customer''s account.' end);
    if p_method = 'token' then
      if p_child_id is not null and v_tok.child_id is not null and v_tok.child_id <> p_child_id then
        v_checks := v_checks || jsonb_build_object('key', 'token_child', 'label', 'Token is for this child', 'ok', false,
          'detail', 'This token was issued for a different child.');
      end if;
    end if;
  end if;

  select count(*) into v_dupe from public.bookings b
  where b.session_id = p_session_id and b.user_id = p_user_id
    and b.status in ('pending', 'confirmed', 'waitlisted', 'completed')
    and (v_child_id is null or b.child_id is null or b.child_id = v_child_id);
  v_checks := v_checks || jsonb_build_object('key', 'duplicate', 'label', 'Not already booked into this class', 'ok', v_dupe = 0,
    'detail', case when v_dupe = 0 then 'No existing booking for this customer in this class'
                   else 'This customer already has a booking in this class.' end);

  select bool_and((c->>'ok')::boolean) into v_ok from jsonb_array_elements(v_checks) c;
  return jsonb_build_object(
    'ok', coalesce(v_ok, false), 'checks', v_checks,
    'class', jsonb_build_object('title', v_s.title, 'vendor', v_s.vendor, 'vendor_id', v_s.provider_id, 'starts_at', v_s.starts_at),
    'funding', v_fund);
end;
$$;

create or replace function public.admin_create_booking(
  p_user_id uuid,
  p_session_id uuid,
  p_method text,
  p_purchase_id uuid default null,
  p_token_id uuid default null,
  p_child_id uuid default null,
  p_guest_name text default null,
  p_guest_contact text default null,
  p_paid boolean default false,
  p_allow_over_capacity boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_check   jsonb;
  v_bad     text;
  v_cap     int;
  v_taken   int;
  v_raised  boolean := false;
  v_pur     public.package_purchases;
  v_tok     public.make_up_tokens;
  v_child   uuid := p_child_id;
  v_id      uuid;
  v_status  text;
  v_before  int;
  v_after   int;
  v_n       int;
begin
  if p_method not in ('credit', 'token', 'manual') then
    raise exception 'Choose credit, make-up token or manual booking.';
  end if;
  if p_method = 'manual' and nullif(btrim(p_guest_name), '') is null then
    raise exception 'A name is required for a manual booking.';
  end if;

  -- Same lock handle_booking_insert takes, held to the end of this transaction.
  select s.capacity into v_cap from public.activity_sessions s where s.id = p_session_id for update;
  if not found then
    raise exception 'That class time no longer exists.';
  end if;

  -- Lock the credit / token so two admins (or an admin and the customer) cannot spend it twice.
  if p_method = 'credit' then
    select * into v_pur from public.package_purchases where id = p_purchase_id for update;
  elsif p_method = 'token' then
    select * into v_tok from public.make_up_tokens where id = p_token_id for update;
  end if;

  -- The safeguard: the very same checks the admin saw, run again under the locks.
  v_check := public.admin_booking_checks(p_user_id, p_session_id, p_method, p_purchase_id, p_token_id, p_child_id, p_allow_over_capacity);
  if not coalesce((v_check->>'ok')::boolean, false) then
    select c->>'detail' into v_bad from jsonb_array_elements(v_check->'checks') c where (c->>'ok')::boolean is not true limit 1;
    raise exception 'Not booked. %', coalesce(v_bad, 'Verification failed.');
  end if;

  -- ---- manual ---------------------------------------------------------------
  if p_method = 'manual' then
    if v_cap is not null then
      select count(*) into v_taken from public.bookings b where b.session_id = p_session_id and b.status in ('pending', 'confirmed');
      if v_taken >= v_cap then
        perform set_config('bb.skip_waitlist_offer', 'on', true);
        update public.activity_sessions set capacity = v_taken + 1 where id = p_session_id;
        perform set_config('bb.skip_waitlist_offer', 'off', true);
        v_raised := true;
      end if;
    end if;
    insert into public.bookings (session_id, guest_name, guest_contact, payment_status, status)
    values (p_session_id, btrim(p_guest_name), nullif(btrim(p_guest_contact), ''), case when p_paid then 'paid' else 'none' end, 'confirmed')
    returning id, status into v_id, v_status;
    if v_status <> 'confirmed' then
      raise exception 'Not booked. The class filled up while saving; try again.';
    end if;
    return jsonb_build_object('booking_id', v_id, 'status', v_status, 'method', 'manual', 'capacity_increased', v_raised);
  end if;

  -- ---- credit ---------------------------------------------------------------
  if p_method = 'credit' then
    if v_child is null then
      select c.id into v_child from public.children c where c.parent_id = p_user_id order by c.created_at limit 1;
    end if;
    v_before := v_pur.credits_remaining;
    insert into public.bookings (user_id, session_id, child_id, package_purchase_id, policies_accepted)
    values (p_user_id, p_session_id, v_child, p_purchase_id, '{}'::uuid[])
    returning id, status into v_id, v_status;
    if v_status = 'pending' then
      update public.bookings set status = 'confirmed' where id = v_id;
      v_status := 'confirmed';
    end if;
    if v_status <> 'confirmed' then
      raise exception 'Not booked. The class filled up while saving; no credit was used.';
    end if;
    update public.package_purchases
       set credits_remaining = credits_remaining - 1,
           status = case when credits_remaining - 1 <= 0 then 'used' else status end
     where id = p_purchase_id and credits_remaining >= 1 and status = 'active';
    get diagnostics v_n = row_count;
    select credits_remaining into v_after from public.package_purchases where id = p_purchase_id;
    -- Read-back: exactly one credit gone, and this booking points at the pack.
    if v_n <> 1 or v_after is distinct from v_before - 1
       or not exists (select 1 from public.bookings where id = v_id and package_purchase_id = p_purchase_id) then
      raise exception 'Not booked. The credit balance did not change as expected, so nothing was saved.';
    end if;
    return jsonb_build_object('booking_id', v_id, 'status', v_status, 'method', 'credit',
      'credits_before', v_before, 'credits_after', v_after);
  end if;

  -- ---- make-up token --------------------------------------------------------
  v_child := v_tok.child_id;
  insert into public.bookings (user_id, session_id, child_id, policies_accepted)
  values (p_user_id, p_session_id, v_child, '{}'::uuid[])
  returning id, status into v_id, v_status;
  if v_status = 'pending' then
    update public.bookings set status = 'confirmed' where id = v_id;
    v_status := 'confirmed';
  end if;
  if v_status <> 'confirmed' then
    raise exception 'Not booked. The class filled up while saving; the token was not used.';
  end if;
  update public.make_up_tokens
     set status = 'redeemed', redeemed_booking_id = v_id
   where id = p_token_id and status = 'issued';
  get diagnostics v_n = row_count;
  if v_n <> 1 or not exists (
       select 1 from public.make_up_tokens where id = p_token_id and status = 'redeemed' and redeemed_booking_id = v_id) then
    raise exception 'Not booked. The token could not be marked as used, so nothing was saved.';
  end if;
  return jsonb_build_object('booking_id', v_id, 'status', v_status, 'method', 'token');
end;
$$;

revoke all on function public.admin_booking_checks(uuid, uuid, text, uuid, uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.admin_booking_checks(uuid, uuid, text, uuid, uuid, uuid, boolean) to service_role;
revoke all on function public.admin_create_booking(uuid, uuid, text, uuid, uuid, uuid, text, text, boolean, boolean) from public, anon, authenticated;
grant execute on function public.admin_create_booking(uuid, uuid, text, uuid, uuid, uuid, text, text, boolean, boolean) to service_role;

notify pgrst, 'reload schema';

commit;
