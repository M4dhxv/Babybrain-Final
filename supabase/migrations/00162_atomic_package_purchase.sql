-- 00162_atomic_package_purchase.sql
--
-- The booking page's "Buy pack" used to purchase a pack independent of the
-- main "Pay" CTA — no slot or Provider-terms gating — and when a session
-- *was* attached, the Stripe webhook granted credits and then auto-booked
-- exactly one seat / decremented exactly one credit
-- (lib/stripe-package-auto-book.ts) as two separate, non-atomic writes,
-- always ignoring how many children (`quantity`) the parent actually picked.
--
-- This migration adds the single atomic function the webhook and
-- /api/stripe/reconcile now call instead: grant the pack's credits, and (when
-- a session was chosen) book that many seats and decrement that many
-- credits, all in one transaction. Booking eligibility/capacity logic is
-- deliberately identical to redeem_package_credit (00156) — same provider /
-- activity_ids / allowed_weekday / allowed_start_time checks, same per-seat
-- insert loop feeding the existing handle_booking_insert trigger for
-- capacity/waitlist/provider_id.
--
-- Also closes a narrow race the old code had no guard against: nothing
-- stopped a redelivered webhook event and a client-triggered reconcile call
-- from both creating a package_purchases row for the same Stripe payment.
-- The unique index + `on conflict do nothing` below makes that dedupe
-- atomic, same pattern as boost_purchases (00158).
--
-- Idempotent.

begin;

create unique index if not exists package_purchases_payment_intent_key
  on public.package_purchases (stripe_payment_intent)
  where stripe_payment_intent is not null;

create or replace function public.purchase_package_and_book(
  p_user_id uuid,
  p_package_id uuid,
  p_stripe_payment_intent text,
  p_activity_session_id uuid default null,
  p_child_id uuid default null,
  p_quantity int default 1,
  p_policies uuid[] default '{}',
  p_medical text default null,
  p_info text default null,
  p_guest_names text[] default '{}'
)
returns table (purchase_id uuid, status text, waitlisted_count int, already_credited boolean)
language plpgsql
security definer
set search_path to 'public'
as $function$
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

  return query select v_purchase_id, (case when v_any_confirmed then 'confirmed' else 'waitlisted' end), v_waitlisted_count, false;
end;
$function$;

-- Called only from server code with the service-role client (Stripe webhook,
-- /api/stripe/reconcile) — same access pattern as cancel_wix_session (00146).
revoke all on function public.purchase_package_and_book(uuid, uuid, text, uuid, uuid, int, uuid[], text, text, text[]) from public, anon, authenticated;
grant execute on function public.purchase_package_and_book(uuid, uuid, text, uuid, uuid, int, uuid[], text, text, text[]) to service_role;

notify pgrst, 'reload schema';

commit;
