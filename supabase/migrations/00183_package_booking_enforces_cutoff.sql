-- 00183_package_booking_enforces_cutoff.sql
--
-- A parent paid for a pack + class ~22h before a class whose vendor closes
-- bookings 24h ahead, and was booked in (28 Sep). The seat is inserted by the
-- Stripe webhook as the service role, and enforce_booking_insert_defaults()
-- returns early for the service role, so none of the parent-facing booking
-- rules ran on this path. 8a3478c made the checkout route refuse such a class
-- before payment; this is the database backstop for anything that changes
-- between checkout and payment (the parent crossing the cutoff on the Stripe
-- page, the vendor pausing the class or session, the provider going inactive).
--
-- Any of those now skips the seat and keeps the credits, like the other
-- mismatches in that check. Existing bookings are not touched.
--
-- Idempotent.

create or replace function public.purchase_package_and_book(p_user_id uuid, p_package_id uuid, p_stripe_payment_intent text, p_activity_session_id uuid DEFAULT NULL::uuid, p_child_id uuid DEFAULT NULL::uuid, p_quantity integer DEFAULT 1, p_policies uuid[] DEFAULT '{}'::uuid[], p_medical text DEFAULT NULL::text, p_info text DEFAULT NULL::text, p_guest_names text[] DEFAULT '{}'::text[])
 RETURNS TABLE(purchase_id uuid, status text, waitlisted_count integer, already_credited boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_pkg public.packages;
  v_purchase_id uuid;
  v_existing_id uuid;
  v_session record;
  v_booking_id uuid;
  v_this_status text;
  v_any_confirmed boolean := false;
  v_waitlisted_count int := 0;
  v_group uuid;
  v_i int;
begin
  if p_quantity < 1 then
    p_quantity := 1;
  end if;

  select * into v_pkg from public.packages where id = p_package_id;
  if not found then
    raise exception 'Package not found';
  end if;

  -- Atomic dedupe: a redelivered webhook event and a client-triggered
  -- reconcile call can both reach here for the same completed checkout.
  -- The partial unique index only fires when the payment intent is set
  -- (always true for a real completed Checkout Session), so this is a no-op
  -- for the null case rather than a hard block.
  insert into public.package_purchases (
    user_id, package_id, provider_id, credits_total, credits_remaining, stripe_payment_intent
  ) values (
    p_user_id, v_pkg.id, v_pkg.provider_id, v_pkg.credits, v_pkg.credits, p_stripe_payment_intent
  )
  on conflict (stripe_payment_intent) where stripe_payment_intent is not null
  do nothing
  returning id into v_purchase_id;

  if v_purchase_id is null then
    select id into v_existing_id from public.package_purchases
    where stripe_payment_intent = p_stripe_payment_intent;
    return query select v_existing_id, 'already_credited'::text, 0, true;
    return;
  end if;

  -- No session to book (pack bought without a class attached, e.g. the
  -- Profile "Packages" tab) — credits only, exactly like today.
  if p_activity_session_id is null then
    return query select v_purchase_id, 'granted'::text, 0, false;
    return;
  end if;

  select s.id, s.starts_at, s.activity_id, a.provider_id, a.bookings_paused,
         s.bookings_paused as session_paused,
         coalesce(s.booking_cutoff_minutes, a.booking_cutoff_minutes, 15) as cutoff_minutes,
         pr.status as provider_status
    into v_session
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  left join public.providers pr on pr.id = a.provider_id
  where s.id = p_activity_session_id;

  -- Any mismatch here (session gone, wrong provider, pack restrictions no
  -- longer apply, session paused, or the pack simply doesn't have enough
  -- credits for this many seats) leaves the grant alone and just skips
  -- booking — the client and /api/customer/stripe/package already reject a
  -- quantity the pack can't cover before any payment happens, so reaching
  -- this branch means something changed *after* checkout started; the money
  -- was already taken, so the credits must never be lost even though the
  -- seat can't be booked as intended.
  if not found
     or v_session.provider_id is null
     or v_session.provider_id <> v_pkg.provider_id
     or coalesce(v_session.bookings_paused, false)
     -- 00183: the same parent-facing rules enforce_booking_insert_defaults()
     -- applies to a normal booking, which it skips for this service-role
     -- insert. The checkout route checks them before payment; these catch a
     -- parent who crossed the cutoff (or a vendor who paused) while on the
     -- Stripe page. Credits are still granted -- the money was taken.
     or coalesce(v_session.session_paused, false)
     or coalesce(v_session.provider_status, 'active') <> 'active'
     or v_session.starts_at - make_interval(mins => v_session.cutoff_minutes) <= now()
     or (v_pkg.activity_ids is not null and array_length(v_pkg.activity_ids, 1) > 0
         and not (v_session.activity_id = any(v_pkg.activity_ids)))
     or (v_pkg.allowed_weekday is not null
         and extract(dow from v_session.starts_at at time zone 'Asia/Singapore') <> v_pkg.allowed_weekday)
     or (v_pkg.allowed_start_time is not null
         and (v_session.starts_at at time zone 'Asia/Singapore')::time <> v_pkg.allowed_start_time)
     or p_quantity > v_pkg.credits
  then
    return query select v_purchase_id, 'granted'::text, 0, false;
    return;
  end if;

  -- 00182: book inside a sub-block. Anything the bookings triggers raise
  -- (capacity, a notification it can't write, a rule added later) used to
  -- abort the WHOLE call, taking the credit grant above down with it -- the
  -- parent had paid and ended up with neither credits nor a seat. The
  -- sub-block rolls back only the seat(s); the purchase stays granted.
  begin
    v_group := case when p_quantity > 1 then gen_random_uuid() else null end;

    for v_i in 1..p_quantity loop
      insert into public.bookings (
        user_id, session_id, child_id, guest_name, package_purchase_id, policies_accepted,
        medical_disclosure, info_response, booking_group_id
      )
      values (
        p_user_id,
        p_activity_session_id,
        case when v_i = 1 then p_child_id else null end,
        case when v_i = 1 then null
             else coalesce(nullif(btrim(p_guest_names[v_i - 1]), ''), 'Guest child') end,
        v_purchase_id,
        coalesce(p_policies, '{}'::uuid[]),
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
    where id = v_purchase_id;
  exception when others then
    raise warning 'purchase_package_and_book: purchase % kept, booking skipped: % (%)',
      v_purchase_id, sqlerrm, sqlstate;
    return query select v_purchase_id, 'granted'::text, 0, false;
    return;
  end;

  return query select v_purchase_id, (case when v_any_confirmed then 'confirmed' else 'waitlisted' end), v_waitlisted_count, false;
end;
$function$;
