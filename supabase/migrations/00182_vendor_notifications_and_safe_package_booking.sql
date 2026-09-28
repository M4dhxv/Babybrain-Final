-- 00182_vendor_notifications_and_safe_package_booking.sql
--
-- A parent paid SGD 710 for a Wonder Tots package (28 Sep) and got nothing:
-- no credits, no seat, and the Stripe webhook still answered 200.
--
-- 1. notifications / stream_users / push_subscriptions referenced
--    parent_profiles(id). Since 00165 vendor-only logins (business claim,
--    staff invite, provisioned accounts) have no parent_profiles row, so
--    notify_provider_booking_received() -- which notifies every active
--    provider_members row -- hit notifications_user_id_fkey and aborted the
--    booking that fired it. Any booking reaching 'confirmed' at a provider
--    with such a member failed (5 live providers at the time). Chat
--    (stream_users) and push (push_subscriptions) have the same shape: they
--    belong to any signed-in user, not just parents. Re-point all three at
--    auth.users(id). The email sender already resolves a recipient without a
--    parent profile via the auth admin API
--    (app/api/webhooks/notifications/route.ts), and deleting a user still
--    cascades exactly as before.
--
-- 2. purchase_package_and_book(): the booking half now runs in a sub-block,
--    so a booking failure can no longer void the credits the parent paid for
--    (see the comment in the function). The app layer also now answers the
--    webhook with a 500 when the call itself fails, so Stripe retries.
--
-- Idempotent.

alter table public.notifications drop constraint if exists notifications_user_id_fkey;
alter table public.notifications
  add constraint notifications_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete cascade;

alter table public.stream_users drop constraint if exists stream_users_user_id_fkey;
alter table public.stream_users
  add constraint stream_users_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete cascade;

alter table public.push_subscriptions drop constraint if exists push_subscriptions_user_id_fkey;
alter table public.push_subscriptions
  add constraint push_subscriptions_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete cascade;

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

  select s.id, s.starts_at, s.activity_id, a.provider_id, a.bookings_paused
    into v_session
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
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
