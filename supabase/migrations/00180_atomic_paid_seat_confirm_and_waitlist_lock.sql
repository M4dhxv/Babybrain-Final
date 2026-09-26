-- 00180_atomic_paid_seat_confirm_and_waitlist_lock.sql
--
-- Two concurrency gaps found in a follow-up audit to 00156 (which fixed
-- booking-insert capacity and credit/token redemption, but not these):
--
-- 1. "Pay now" claim of a freed waitlist seat (app/api/bookings/checkout)
--    re-checks capacity before creating the Stripe Checkout Session, but the
--    actual confirm — flipping the paid seat's status to 'confirmed' — ran
--    as a plain UPDATE in the webhook and in /api/stripe/reconcile (a
--    safety-net path that intentionally races the webhook), with no lock
--    and no re-check. Two parents invited to pay for the same last freed
--    seat could both complete payment and both get confirmed: a real
--    overbook, not just a lost promotion. confirm_paid_booking_seats() now
--    does this under the same session-row lock handle_booking_insert
--    (00156) already uses, so only as many waitlisted seats as truly still
--    fit get confirmed; the rest stay waitlisted for the app layer to
--    refund (see lib/confirm-paid-booking-seats.ts).
--
-- 2. handle_booking_cancel()'s waitlist promotion (00100) picks the front of
--    the queue with a plain SELECT, no lock. Two cancellations on the same
--    session at nearly the same instant can both read the same top-of-queue
--    row before either commits, so both promote/notify that one person and
--    the second freed seat's promotion is silently skipped. Now locks the
--    session row first, same pattern as #1 — a concurrent cancellation on
--    the same session serializes here, so the second one sees the first
--    promotion already committed and correctly moves to the next row.
--
-- Idempotent.

begin;

-- 1 -------------------------------------------------------------------------
create or replace function public.confirm_paid_booking_seats(
  p_seat_ids uuid[],
  p_payment_intent text default null
)
returns table (id uuid, confirmed boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_id uuid;
  v_capacity int;
  v_taken int;
  v_free int;
  v_to_confirm uuid[];
begin
  if p_seat_ids is null or array_length(p_seat_ids, 1) is null then
    return;
  end if;

  select b.session_id into v_session_id from public.bookings b where b.id = p_seat_ids[1];
  if v_session_id is null then
    return;
  end if;

  -- Same lock handle_booking_insert (00156) takes on the session row — a
  -- concurrent claim on the same freed seat (another "Pay now" checkout for
  -- this session, or a fresh direct booking) has to wait here instead of
  -- both readers computing capacity off the same stale count.
  perform 1 from public.activity_sessions s where s.id = v_session_id for update;

  select s.capacity into v_capacity from public.activity_sessions s where s.id = v_session_id;

  -- A `pending` seat already reserved its place at booking time, under that
  -- same lock — paying for it only ever settles the money, never
  -- re-litigates capacity.
  update public.bookings b
  set status = 'confirmed', payment_status = 'paid',
      stripe_payment_intent = coalesce(p_payment_intent, b.stripe_payment_intent)
  where b.id = any(p_seat_ids) and b.status = 'pending';

  -- A `waitlisted` seat reserved nothing — this is the "pay now to claim a
  -- freed seat" path, so capacity is re-checked for real under the lock
  -- above. Only as many as still fit get confirmed, front-of-queue first;
  -- anyone this checkout charged but couldn't seat stays waitlisted so the
  -- caller can refund them without bumping them out of the queue.
  select count(*) into v_taken from public.bookings b
  where b.session_id = v_session_id and b.status in ('pending', 'confirmed');
  v_free := case when v_capacity is null then 2147483647 else greatest(v_capacity - v_taken, 0) end;

  select coalesce(array_agg(w.id), '{}') into v_to_confirm
  from (
    select b.id
    from public.bookings b
    where b.id = any(p_seat_ids) and b.status = 'waitlisted'
    order by b.waitlist_position nulls last, b.created_at
    limit v_free
  ) w;

  if array_length(v_to_confirm, 1) > 0 then
    update public.bookings b
    set status = 'confirmed', payment_status = 'paid', waitlist_position = null,
        stripe_payment_intent = coalesce(p_payment_intent, b.stripe_payment_intent)
    where b.id = any(v_to_confirm);
  end if;

  -- Charged but capacity ran out before this row's turn: stamp the payment
  -- intent so the caller can look up and refund it, but leave status alone.
  update public.bookings b
  set stripe_payment_intent = coalesce(p_payment_intent, b.stripe_payment_intent)
  where b.id = any(p_seat_ids) and b.status = 'waitlisted'
    and not (b.id = any(coalesce(v_to_confirm, '{}'::uuid[])));

  return query
  select b.id, (b.status = 'confirmed') as confirmed
  from public.bookings b
  where b.id = any(p_seat_ids);
end;
$$;

-- Only ever called from the webhook / reconcile server routes via the
-- service-role admin client — same scoping as purchase_package_and_book
-- (00162), which this mirrors.
grant execute on function public.confirm_paid_booking_seats(uuid[], text) to service_role;

-- 2 -------------------------------------------------------------------------
create or replace function public.handle_booking_cancel()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
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
    -- Not paid for. Leave the seat open and invite them to pay for it —
    -- anything else hands out a paid class for free.
    perform public.notify_waitlist_spot_open(v_next.id);
  end if;

  return new;
end;
$$;

notify pgrst, 'reload schema';

commit;
