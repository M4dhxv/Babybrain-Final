-- 00204_waitlist_offer_on_every_freed_seat.sql
--
-- Everyone on a waitlist is told, by email, every time a seat becomes
-- available. Two things stopped that:
--
--   1. notify_waitlist_all_open (00197) skipped anyone it had already mailed
--      for that session in the last 6 HOURS. A second cancellation (or a
--      repeat test) on the same session sent nothing, even though a fresh seat
--      had opened. The de-dup is now 10 MINUTES, which only collapses the
--      duplicate calls one event can make (e.g. a party of two cancelling in
--      one statement), never a later, separate seat. It also now checks the
--      session really has a free seat, so nobody is told "book now" for a seat
--      that is already gone.
--
--   2. Only a status change to 'cancelled' offered the freed seat. A seat is
--      also freed when a booking is moved to another session (reschedule) and
--      when a booking row is deleted (vendor removes a manual booking, a failed
--      checkout clears its pending rows) - neither told the waitlist anything.
--
-- The offer logic moves into offer_freed_seat(session) so all three paths
-- (cancel, reschedule away, delete) behave identically: an already-paid /
-- pack-credit / token / free-class waitlister is confirmed automatically (as
-- before), otherwise every unpaid waitlister gets "a spot is available".
--
-- Unchanged on purpose: a vendor's manual "Promote" (promote_waitlist_entry ->
-- notify_waitlist_spot_open, one person, pay link) and the capacity-increase
-- trigger, which already calls notify_waitlist_all_open.
--
-- Idempotent. ASCII only (the promoted-title emoji is written as an escape).

begin;

-- Tell everyone waiting (unpaid) that a spot is available.
create or replace function public.notify_waitlist_all_open(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r        record;
  v_cap    int;
  v_taken  int;
begin
  select s.capacity into v_cap from public.activity_sessions s where s.id = p_session_id;
  if not found then return; end if;

  -- No free seat (someone else already took it): nothing to offer.
  select count(*) into v_taken from public.bookings b
   where b.session_id = p_session_id and b.status in ('pending', 'confirmed');
  if v_cap is not null and v_taken >= v_cap then return; end if;

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
       -- Collapses duplicate calls from ONE event only; a later freed seat
       -- always gets its own email.
       and not exists (
             select 1 from public.notifications n
              where n.user_id = b.user_id
                and n.type = 'waitlist_available'
                and n.data ->> 'session_id' = p_session_id::text
                and n.created_at > now() - interval '10 minutes')
     order by b.user_id, b.waitlist_position nulls last, b.created_at
  loop
    perform public.notify_waitlist_spot_open(r.id);
  end loop;
end;
$function$;

revoke all on function public.notify_waitlist_all_open(uuid) from public, anon, authenticated;
-- Only ever called from other security-definer functions.
revoke all on function public.notify_waitlist_spot_open(uuid) from public, anon, authenticated;

-- A seat on p_session_id has just been freed.
create or replace function public.offer_freed_seat(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_next    public.bookings;
  v_settled boolean;
begin
  -- Lock the session row so near-simultaneous frees on one session are offered
  -- one after the other (two cancellations must not both pick the same
  -- front-of-queue row). No row = the session itself is being deleted.
  perform 1 from public.activity_sessions s where s.id = p_session_id for update;
  if not found then return; end if;

  select * into v_next
  from public.bookings
  where session_id = p_session_id and status = 'waitlisted'
  order by waitlist_position nulls last, created_at
  limit 1;
  if not found then
    return;
  end if;

  v_settled :=
       v_next.payment_status = 'paid'
    or v_next.package_purchase_id is not null
    or exists (
         select 1 from public.make_up_tokens t
         where t.redeemed_booking_id = v_next.id and t.status = 'redeemed')
    or coalesce(public.session_price(p_session_id), 0) = 0;

  if v_settled then
    update public.bookings
    set status = 'confirmed', waitlist_position = null
    where id = v_next.id;

    insert into public.notifications (user_id, type, title, body, data)
    select v_next.user_id, 'waitlist_promoted', 'You''re off the waitlist! ' || E'\U0001F389',
           'A spot opened up and your place is now confirmed.',
           public.session_email_details(p_session_id) || jsonb_build_object(
             'url', '/profile?tab=bookings',
             'booking_id', v_next.id)
    where v_next.user_id is not null;
  else
    perform public.notify_waitlist_all_open(p_session_id);
  end if;
end;
$function$;

revoke all on function public.offer_freed_seat(uuid) from public, anon, authenticated;

-- Cancellation: same behaviour as 00197, now through offer_freed_seat.
create or replace function public.handle_booking_cancel()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if not (new.status = 'cancelled' and old.status in ('pending', 'confirmed')) then
    return new;
  end if;
  perform public.offer_freed_seat(new.session_id);
  return new;
end;
$function$;

-- Reschedule: the booking left its old session, freeing a seat there.
create or replace function public.offer_seat_on_booking_moved()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if old.status in ('pending', 'confirmed')
     and new.status in ('pending', 'confirmed')
     and new.session_id is distinct from old.session_id then
    perform public.offer_freed_seat(old.session_id);
  end if;
  return new;
end;
$function$;

revoke all on function public.offer_seat_on_booking_moved() from public, anon, authenticated;

drop trigger if exists after_booking_move_offer_seat on public.bookings;
create trigger after_booking_move_offer_seat
  after update of session_id on public.bookings
  for each row execute function public.offer_seat_on_booking_moved();

-- Delete: a live booking row removed outright frees its seat.
create or replace function public.offer_seat_on_booking_deleted()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if old.status in ('pending', 'confirmed') then
    perform public.offer_freed_seat(old.session_id);
  end if;
  return old;
end;
$function$;

revoke all on function public.offer_seat_on_booking_deleted() from public, anon, authenticated;

drop trigger if exists after_booking_delete_offer_seat on public.bookings;
create trigger after_booking_delete_offer_seat
  after delete on public.bookings
  for each row execute function public.offer_seat_on_booking_deleted();

commit;
