-- 00099_waitlist_pay_to_claim.sql
--
-- Two waitlist scenarios reported again, both still on the pre-00090
-- behaviour (00090 either wasn't applied or was rolled past):
--
-- 1. "Cancelled a booking where there was a waitlist and the parent on the
--    waitlist was automatically added to the booking but hadn't paid."
--
--    handle_booking_cancel() (00008) auto-confirms the next waitlisted row
--    with no regard for payment. On a PAID class that hands out a free seat.
--
-- 2. "Increased the capacity — the booking page shows the seats, but the
--    waitlisted booking didn't promote and nobody was told."
--
--    Nothing watches activity_sessions.capacity.
--
-- This migration re-asserts 00090's pay-aware promotion + capacity trigger
-- (so it's correct whether or not 00090 landed), and points the
-- "spot opened" notification at the parent's own Bookings page instead of a
-- fresh booking flow — that page now carries a "Pay now" button that pays
-- for the *existing* waitlisted booking (/api/bookings/checkout with its
-- booking_id) and closes the seat only once payment clears. The offer to
-- pay is fully derived on read (paid class + a free seat + near the front of
-- the queue), so it disappears the moment the seat is taken — no link to
-- expire, no state to sweep.
--
-- All create-or-replace on existing functions plus one trigger; no schema
-- change, no data change.

begin;

-- =============================================================
-- Shared: a session's details for an email (from 00090 — restated here so
-- this migration stands alone if 00090 never ran).
-- =============================================================
create or replace function public.session_email_details(p_session uuid)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'activity_name', a.title,
    'date_time', to_char(
      s.starts_at at time zone 'Asia/Singapore',
      'Dy DD Mon YYYY, HH12:MI AM'),
    'duration', case
      when s.ends_at is not null then
        (extract(epoch from (s.ends_at - s.starts_at)) / 60)::int || ' minutes'
      else null end,
    'address', coalesce(
      nullif(concat_ws(', ', l.name, nullif(btrim(l.address), '')), ''),
      a.address),
    'type', p.business_name
  ))
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  left join public.providers p on p.id = a.provider_id
  left join public.provider_locations l on l.id = coalesce(s.location_id, a.location_id)
  where s.id = p_session;
$$;

-- =============================================================
-- Notify one waitlisted parent that a seat is theirs to claim.
-- Links to their Bookings page, where "Pay now" settles this very booking.
-- =============================================================
create or replace function public.notify_waitlist_spot_open(p_booking uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_bk public.bookings;
begin
  select * into v_bk from public.bookings where id = p_booking;
  if not found or v_bk.user_id is null then return; end if;

  insert into public.notifications (user_id, type, title, body, data)
  values (
    v_bk.user_id,
    'waitlist_available',
    'A spot has opened up — pay to claim it',
    'A place has come free on a class you joined the waitlist for. Pay for '
      || 'your booking to confirm the seat before it goes to someone else.',
    public.session_email_details(v_bk.session_id) || jsonb_build_object(
      'url', '/profile?tab=bookings',
      'booking_id', v_bk.id,
      'session_id', v_bk.session_id
    )
  );
end;
$$;

-- =============================================================
-- 1. Cancellation → pay-aware waitlist promotion
-- =============================================================
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

-- =============================================================
-- 2. Capacity raised → tell the front of the queue
-- =============================================================
create or replace function public.notify_waitlist_on_capacity_increase()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_taken int;
  v_free int;
  r record;
begin
  if new.capacity is not distinct from old.capacity then
    return new;
  end if;
  if new.capacity is not null and old.capacity is not null and new.capacity <= old.capacity then
    return new;
  end if;

  select count(*) into v_taken
  from public.bookings
  where session_id = new.id and status in ('pending', 'confirmed');

  v_free := case when new.capacity is null then 2147483647 else new.capacity - v_taken end;
  if v_free <= 0 then
    return new;
  end if;

  -- One invitation per newly freed seat, in queue order. A settled booking
  -- (credit / token / free class) is taken straight off the waitlist; an
  -- unsettled paid one is invited to pay. First to pay wins.
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
      perform public.notify_waitlist_spot_open(r.id);
    end if;
  end loop;

  return new;
end;
$$;

drop trigger if exists on_session_capacity_increase on public.activity_sessions;
create trigger on_session_capacity_increase
  after update of capacity on public.activity_sessions
  for each row execute function public.notify_waitlist_on_capacity_increase();

notify pgrst, 'reload schema';

commit;
