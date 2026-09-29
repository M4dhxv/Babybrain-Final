-- 00197_free_waitlist.sql
--
-- Founder/owner decision (29 Sep): nobody is charged to be on a waitlist.
-- Joining is free; when a spot opens everyone waiting is told it's available
-- to book, and whoever books first gets it. Before this:
--   * booking a full class with a pack credit (or buying a pack and booking in
--     one go) spent the credit on the waitlisted seat, and a make-up token was
--     marked used even though the booking only reached the waitlist;
--   * only the first person in the queue was told a spot had opened;
--   * "Pay now" on a freed seat didn't hold it, so two parents could both pay
--     for the same spot and one was charged for nothing.
--
-- Now:
--   1. redeem_package_credit / purchase_package_and_book only use credits for
--      seats that were actually booked; waitlisted seats keep no credit link.
--      redeem_make_up_token leaves the token unused when the class is full.
--   2. notify_waitlist_all_open(): every unpaid person on the waitlist is told
--      "a spot is available, book now" (once per person per 6 hours). Used by
--      a cancellation, a capacity increase and an abandoned claim.
--   3. claim_waitlist_seats(): "Pay now" on a waitlisted booking moves it to
--      pending under the session lock BEFORE Stripe, so the seat is held while
--      they pay. No free seat -> refused before any payment.
--   4. release_stale_pending_bookings() (the 5-minute clean-up): a claim hold
--      left unpaid for 45 minutes goes back to the waitlist (not cancelled)
--      and everyone else is told the spot is free again.
--   5. Booking a class you're on the waitlist for (e.g. with a credit, from the
--      "spot available" email) removes your own waitlist entry, silently.
--
-- Entries already on a waitlist that were paid for (legacy) are still
-- confirmed automatically when a seat opens, as before. None are upcoming
-- on production today.
--
-- Idempotent.

alter table public.bookings add column if not exists pending_since timestamptz;
comment on column public.bookings.pending_since is
  'When a waitlisted booking was claimed (moved to pending) via "Pay now". The stale clean-up releases the hold 45 minutes after this, back to the waitlist.';

create or replace function public.notify_waitlist_spot_open(p_booking uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_bk   public.bookings;
  v_slug text;
begin
  select * into v_bk from public.bookings where id = p_booking;
  if not found or v_bk.user_id is null then return; end if;
  select a.slug into v_slug
    from public.activity_sessions s join public.activities a on a.id = s.activity_id
   where s.id = v_bk.session_id;
  insert into public.notifications (user_id, type, title, body, data)
  values (
    v_bk.user_id,
    'waitlist_available',
    'A spot is available — book now',
    'A place has come free on a class you''re on the waitlist for. Book now to '
      || 'take it; the first to book gets the spot. You haven''t been charged anything.',
    public.session_email_details(v_bk.session_id) || jsonb_build_object(
      -- A vendor "Promote" is a personal offer that can go over capacity, so
      -- it keeps the Pay now link on the parent's bookings; everyone else
      -- books the freed seat like any other booking.
      'url', case when v_bk.waitlist_pay_invited or v_slug is null
                  then '/profile?tab=bookings'
                  else '/book?slug=' || v_slug || '&session=' || v_bk.session_id end,
      'booking_id', v_bk.id,
      'session_id', v_bk.session_id
    )
  );
end;
$function$;

-- Tell everyone waiting (unpaid) that a spot is available. One email per
-- person per session, and not again within 6 hours.
create or replace function public.notify_waitlist_all_open(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r record;
begin
  for r in
    select distinct on (b.user_id) b.id
      from public.bookings b
     where b.session_id = p_session_id
       and b.status = 'waitlisted'
       and b.user_id is not null
       and not (b.payment_status = 'paid'
                or b.package_purchase_id is not null
                or exists (select 1 from public.make_up_tokens t
                            where t.redeemed_booking_id = b.id and t.status = 'redeemed'))
       and not exists (
             select 1 from public.notifications n
              where n.user_id = b.user_id
                and n.type = 'waitlist_available'
                and n.data ->> 'session_id' = p_session_id::text
                and n.created_at > now() - interval '6 hours')
     order by b.user_id, b.waitlist_position nulls last, b.created_at
  loop
    perform public.notify_waitlist_spot_open(r.id);
  end loop;
end;
$function$;

revoke all on function public.notify_waitlist_all_open(uuid) from public, anon, authenticated;

-- "Pay now" on a waitlisted booking: hold the seat(s) before Stripe. All or
-- nothing for a party. A vendor-promoted booking may go over capacity (the
-- absorb_over_capacity_claim trigger grows the session to fit).
create or replace function public.claim_waitlist_seats(p_seat_ids uuid[])
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_session uuid;
  v_cap     int;
  v_taken   int;
  r         record;
begin
  select b.session_id into v_session from public.bookings b where b.id = p_seat_ids[1];
  if v_session is null then
    raise exception 'Booking not found';
  end if;
  -- Same session-row lock every booking path takes, so two claims (or a
  -- claim and a fresh booking) can't both see the same free seat.
  perform 1 from public.activity_sessions s where s.id = v_session for update;
  select s.capacity into v_cap from public.activity_sessions s where s.id = v_session;
  select count(*) into v_taken from public.bookings b
   where b.session_id = v_session and b.status in ('pending', 'confirmed');
  for r in
    select b.id, b.waitlist_pay_invited
      from public.bookings b
     where b.id = any(p_seat_ids) and b.status = 'waitlisted'
     order by b.waitlist_position nulls last, b.created_at
  loop
    if v_cap is null or v_taken < v_cap or r.waitlist_pay_invited then
      update public.bookings set status = 'pending', pending_since = now() where id = r.id;
      v_taken := v_taken + 1;
    else
      raise exception 'That spot has been taken — you''re still on the waitlist.';
    end if;
  end loop;
end;
$function$;

revoke all on function public.claim_waitlist_seats(uuid[]) from public, anon, authenticated;
grant execute on function public.claim_waitlist_seats(uuid[]) to service_role;

-- The 5-minute clean-up of unpaid pending bookings.
create or replace function public.release_stale_pending_bookings()
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r record;
begin
  -- A claim hold that wasn't paid for goes back to the waitlist, keeping its
  -- place, and everyone else hears the spot is free again.
  for r in
    with released as (
      update public.bookings
         set status = 'waitlisted', pending_since = null
       where status = 'pending'
         and payment_status = 'none'
         and pending_since is not null
         and pending_since < now() - interval '45 minutes'
      returning session_id
    )
    select distinct session_id from released
  loop
    perform public.notify_waitlist_all_open(r.session_id);
  end loop;

  -- An ordinary unpaid booking is cancelled, as before.
  update public.bookings
     set status = 'cancelled'
   where status = 'pending'
     and payment_status = 'none'
     and pending_since is null
     and created_at < now() - interval '45 minutes';
end;
$function$;

revoke all on function public.release_stale_pending_bookings() from public, anon, authenticated;

select cron.unschedule(jobid) from cron.job where jobname = 'cancel-stale-pending-bookings';
select cron.schedule('cancel-stale-pending-bookings', '*/5 * * * *', $$select public.release_stale_pending_bookings();$$);

-- Booking a class you're already waiting for removes your own waitlist entry.
create or replace function public.clear_own_waitlist_entry()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.user_id is null or new.status not in ('pending', 'confirmed') then
    return new;
  end if;
  update public.bookings b
     set status = 'cancelled',
         cancel_reason = 'Booked a place on this class',
         waitlist_position = null
   where b.session_id = new.session_id
     and b.user_id = new.user_id
     and b.status = 'waitlisted'
     and b.id <> new.id
     and b.child_id is not distinct from new.child_id
     and coalesce(b.guest_name, '') = coalesce(new.guest_name, '')
     and (new.booking_group_id is null or b.booking_group_id is distinct from new.booking_group_id);
  return new;
end;
$function$;

drop trigger if exists after_booking_insert_clear_waitlist on public.bookings;
create trigger after_booking_insert_clear_waitlist
  after insert on public.bookings
  for each row execute function public.clear_own_waitlist_entry();

CREATE OR REPLACE FUNCTION public.handle_booking_cancel()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_next public.bookings;
  v_settled boolean;
begin
  if not (new.status = 'cancelled' and old.status in ('pending', 'confirmed')) then
    return new;
  end if;

  -- Lock the session row so a second cancellation on the same session
  -- (near-simultaneous with this one) waits for this promotion to commit
  -- before it reads the waitlist — otherwise both can pick the same
  -- front-of-queue row and the other freed seat's promotion is skipped.
  perform 1 from public.activity_sessions s where s.id = new.session_id for update;

  select * into v_next
  from public.bookings
  where session_id = new.session_id and status = 'waitlisted'
  order by waitlist_position nulls last, created_at
  limit 1;
  if not found then
    return new;
  end if;

  v_settled :=
       v_next.payment_status = 'paid'
    or v_next.package_purchase_id is not null
    or exists (
         select 1 from public.make_up_tokens t
         where t.redeemed_booking_id = v_next.id and t.status = 'redeemed')
    or coalesce(public.session_price(new.session_id), 0) = 0;

  if v_settled then
    update public.bookings
    set status = 'confirmed', waitlist_position = null
    where id = v_next.id;

    insert into public.notifications (user_id, type, title, body, data)
    select v_next.user_id, 'waitlist_promoted', 'You''re off the waitlist! 🎉',
           'A spot opened up and your place is now confirmed.',
           public.session_email_details(new.session_id) || jsonb_build_object(
             'url', '/profile?tab=bookings',
             'booking_id', v_next.id)
    where v_next.user_id is not null;
  else
    -- 00197: not paid for. Leave the seat open and tell everyone waiting it's
    -- available to book; the first to book gets it.
    perform public.notify_waitlist_all_open(new.session_id);
  end if;

  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.notify_waitlist_on_capacity_increase()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_taken int;
  v_free int;
  r record;
  v_notify boolean := false;
begin
  -- A vendor's manual booking over capacity (add_manual_booking_over_capacity)
  -- claims the new seat itself; the waitlist is not offered it.
  if current_setting('bb.skip_waitlist_offer', true) = 'on' then
    return new;
  end if;

  if new.capacity is not distinct from old.capacity then
    return new;
  end if;
  if new.capacity is not null and old.capacity is not null and new.capacity <= old.capacity then
    return new;
  end if;

  select count(*) into v_taken
  from public.bookings b
  where b.session_id = new.id and b.status in ('pending', 'confirmed');

  v_free := case when new.capacity is null then 2147483647 else new.capacity - v_taken end;
  if v_free <= 0 then
    return new;
  end if;

  for r in
    select b.id, b.user_id,
           (b.payment_status = 'paid'
            or b.package_purchase_id is not null
            or exists (select 1 from public.make_up_tokens t
                       where t.redeemed_booking_id = b.id and t.status = 'redeemed')
            or coalesce(public.session_price(new.id), 0) = 0) as settled
    from public.bookings b
    where b.session_id = new.id and b.status = 'waitlisted'
    order by b.waitlist_position nulls last, b.created_at
    limit v_free
  loop
    if r.settled then
      update public.bookings set status = 'confirmed', waitlist_position = null where id = r.id;
      insert into public.notifications (user_id, type, title, body, data)
      select r.user_id, 'waitlist_promoted', 'You''re off the waitlist! 🎉',
             'A spot opened up and your place is now confirmed.',
             public.session_email_details(new.id) || jsonb_build_object(
               'url', '/profile?tab=bookings', 'booking_id', r.id)
      where r.user_id is not null;
    else
      v_notify := true;
    end if;
  end loop;
  -- 00197: tell everyone waiting, not just those who fit the new seats.
  if v_notify then
    perform public.notify_waitlist_all_open(new.id);
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.redeem_package_credit(p_purchase_id uuid, p_session_id uuid, p_child_id uuid DEFAULT NULL::uuid, p_policies uuid[] DEFAULT '{}'::uuid[], p_wix_booking_id text DEFAULT NULL::text, p_quantity integer DEFAULT 1, p_medical text DEFAULT NULL::text, p_info text DEFAULT NULL::text, p_guest_names text[] DEFAULT '{}'::text[])
 RETURNS TABLE(status text, waitlisted_count integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user uuid := auth.uid();
  v_pur public.package_purchases;
  v_pkg public.packages;
  v_session record;
  v_booking_id uuid;
  v_this_status text;
  v_any_confirmed boolean := false;
  v_waitlisted_count int := 0;
  v_waitlisted_ids uuid[] := '{}';
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

  -- Locked: two concurrent redemptions of the same pack's last credit(s)
  -- must not both pass this check before either commits its decrement.
  select * into v_pur
  from public.package_purchases pp
  where pp.id = p_purchase_id
    and pp.user_id = v_user
    and pp.status = 'active'
    and pp.credits_remaining >= p_quantity
    and (pp.expires_at is null or pp.expires_at > now())
  for update;
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
        v_waitlisted_ids := v_waitlisted_ids || v_booking_id;
    else
      v_any_confirmed := true;
    end if;
  end loop;

  -- 00197: only seats actually booked use a credit; a waitlisted seat is free.
      update public.package_purchases
      set credits_remaining = credits_remaining - (p_quantity - v_waitlisted_count),
          status = case when credits_remaining - (p_quantity - v_waitlisted_count) <= 0 then 'used' else package_purchases.status end
      where id = p_purchase_id;
      update public.bookings set package_purchase_id = null where id = any(v_waitlisted_ids);

  return query select (case when v_any_confirmed then 'confirmed' else 'waitlisted' end), v_waitlisted_count;
end;
$function$;

CREATE OR REPLACE FUNCTION public.purchase_package_and_book(p_user_id uuid, p_package_id uuid, p_stripe_payment_intent text, p_activity_session_id uuid DEFAULT NULL::uuid, p_child_id uuid DEFAULT NULL::uuid, p_quantity integer DEFAULT 1, p_policies uuid[] DEFAULT '{}'::uuid[], p_medical text DEFAULT NULL::text, p_info text DEFAULT NULL::text, p_guest_names text[] DEFAULT '{}'::text[])
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
  v_waitlisted_ids uuid[] := '{}';
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
        v_waitlisted_ids := v_waitlisted_ids || v_booking_id;
      else
        v_any_confirmed := true;
      end if;
    end loop;

    -- 00197: only seats actually booked use a credit; a waitlisted seat is free.
      update public.package_purchases
      set credits_remaining = credits_remaining - (p_quantity - v_waitlisted_count),
          status = case when credits_remaining - (p_quantity - v_waitlisted_count) <= 0 then 'used' else package_purchases.status end
      where id = v_purchase_id;
      update public.bookings set package_purchase_id = null where id = any(v_waitlisted_ids);
  exception when others then
    raise warning 'purchase_package_and_book: purchase % kept, booking skipped: % (%)',
      v_purchase_id, sqlerrm, sqlstate;
    return query select v_purchase_id, 'granted'::text, 0, false;
    return;
  end;

  return query select v_purchase_id, (case when v_any_confirmed then 'confirmed' else 'waitlisted' end), v_waitlisted_count, false;
end;
$function$;

CREATE OR REPLACE FUNCTION public.redeem_make_up_token(p_token_id uuid, p_session_id uuid, p_policies uuid[] DEFAULT '{}'::uuid[], p_medical text DEFAULT NULL::text, p_info text DEFAULT NULL::text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  -- Locked: two concurrent redemptions of the same token must not both pass
  -- this check before either commits its status update.
  select * into v_tok
  from public.make_up_tokens
  where id = p_token_id
    and user_id = v_user
    and status = 'issued'
    and (expires_at is null or expires_at > now())
  for update;
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

  -- 00197: a full class puts the parent on the waitlist for free; the token
  -- stays unused for when they actually book.
  if v_status <> 'waitlisted' then
    update public.make_up_tokens
    set status = 'redeemed', redeemed_booking_id = v_booking_id
    where id = p_token_id;
  end if;

  return v_status;
end;
$function$;

CREATE OR REPLACE FUNCTION public.notify_booking_cancelled()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_title    text;
  v_provider text;
  v_mode     text;
  v_child    text;
  v_tail     text;
begin
  -- 00197: leaving the waitlist because you booked the class isn't a
  -- cancellation to tell anyone about.
  if old.status = 'waitlisted' and new.cancel_reason = 'Booked a place on this class' then
    return new;
  end if;
  if new.status = 'cancelled'
     and old.status is distinct from 'cancelled'
     and new.user_id is not null then
    select a.title, p.business_name,
           coalesce(nullif(new.cancel_refund_mode, ''), a.cancellation_refund_mode, 'refund')
      into v_title, v_provider, v_mode
    from public.activity_sessions s
    join public.activities a on a.id = s.activity_id
    left join public.providers p on p.id = a.provider_id
    where s.id = new.session_id;

    -- Whose seat this was: the guest name for a guest seat, else the child's
    -- profile name (null for a booking with neither).
    v_child := coalesce(
      nullif(btrim(new.guest_name), ''),
      (select c.name from public.children c where c.id = new.child_id)
    );

    if new.cancelled_by is not null then
      -- Vendor cancelled: the branded class_cancelled email (lib/emails/render.ts),
      -- naming the child. This is the only cancellation that emails the parent.
      insert into public.notifications (user_id, type, title, body, data)
      values (
        new.user_id,
        'class_cancelled',
        'Unfortunately your class has been cancelled',
        'Unfortunately ' || coalesce(v_title, 'your class') ||
          case when v_child is not null then ' has been cancelled for ' || v_child else ' has been cancelled' end ||
          '. Any refund or make up token issuance follows the policy of ' ||
          coalesce(v_provider, 'the provider') || '.',
        jsonb_build_object(
          'activity_name', v_title,
          'provider_name', v_provider,
          'child_name', v_child,
          'url', '/profile?tab=bookings',
          'booking_id', new.id
        )
      );
    else
      -- Parent (or system) cancelled: in-app notice only, no email.
      v_tail := case when v_mode = 'none'
        then 'This class is non-refundable, so no credit or make-up token was issued.'
        else 'Any refund follows the provider''s policy.'
      end;
      insert into public.notifications (user_id, type, title, body, data, email_status)
      values (
        new.user_id,
        'booking_cancelled',
        'Booking cancelled',
        'Your booking for ' || coalesce(v_title, 'a class') || ' has been cancelled. ' || v_tail,
        jsonb_build_object('url', '/profile?tab=bookings', 'booking_id', new.id),
        'skipped'
      );
    end if;
  end if;
  return new;
end;
$function$;
