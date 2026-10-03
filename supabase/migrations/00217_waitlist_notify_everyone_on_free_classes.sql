-- 00217_waitlist_notify_everyone_on_free_classes.sql
--
-- "When a space becomes available, everyone on the waitlist is told" still had
-- one exception: a FREE class. offer_freed_seat (00204) and the capacity
-- trigger (00197) both treated a free class's waitlist entry as "settled",
-- the same as one that had already been paid for, so the freed seat was handed
-- straight to the first person in the queue. They got "You're off the
-- waitlist" and nobody else heard anything: one person notified, however many
-- were waiting. QA's "only 1 is being notified".
--
-- Now a free class behaves like every other class (the 00197 rule): the seat
-- stays open, every waitlisted parent gets "a spot is available, book now",
-- and the first to book takes it. Booking it removes their own waitlist entry
-- (clear_own_waitlist_entry, 00197).
--
-- Still confirmed automatically, on purpose: an entry that was genuinely paid
-- for before 00197 (card, pack credit or make-up token). That parent has
-- already paid for the seat, so it is theirs. Both functions now look for the
-- first such entry anywhere in the queue rather than only at its head, and
-- then still tell everyone else if a seat is left over.
--
-- Unchanged: a vendor's manual "Promote" (one person, by design), and
-- notify_waitlist_all_open itself, which already checks that a seat is really
-- free and skips anyone told about this session in the last 10 minutes.
--
-- Idempotent. ASCII only (the promoted-title emoji is written as an escape).

begin;

-- A seat on p_session_id has just been freed.
create or replace function public.offer_freed_seat(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_paid public.bookings;
begin
  -- Lock the session row so near-simultaneous frees on one session are offered
  -- one after the other (two cancellations must not both pick the same
  -- already-paid row). No row = the session itself is being deleted.
  perform 1 from public.activity_sessions s where s.id = p_session_id for update;
  if not found then return; end if;

  -- An entry that has already been paid for takes the seat outright.
  select b.* into v_paid
  from public.bookings b
  where b.session_id = p_session_id
    and b.status = 'waitlisted'
    and (b.payment_status = 'paid'
         or b.package_purchase_id is not null
         or exists (select 1 from public.make_up_tokens t
                     where t.redeemed_booking_id = b.id and t.status = 'redeemed'))
  order by b.waitlist_position nulls last, b.created_at
  limit 1;

  if found then
    update public.bookings
    set status = 'confirmed', waitlist_position = null
    where id = v_paid.id;

    insert into public.notifications (user_id, type, title, body, data)
    select v_paid.user_id, 'waitlist_promoted', 'You''re off the waitlist! ' || E'\U0001F389',
           'A spot opened up and your place is now confirmed.',
           public.session_email_details(p_session_id) || jsonb_build_object(
             'url', '/profile?tab=bookings',
             'booking_id', v_paid.id)
    where v_paid.user_id is not null;
  end if;

  -- Everyone else waiting is told, free class or paid. A no-op when the seat
  -- was just taken above (notify_waitlist_all_open checks for a free seat).
  perform public.notify_waitlist_all_open(p_session_id);
end;
$function$;

revoke all on function public.offer_freed_seat(uuid) from public, anon, authenticated;

-- A session's capacity was raised.
create or replace function public.notify_waitlist_on_capacity_increase()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_taken int;
  v_free  int;
  r       record;
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

  -- Entries already paid for take the new seats first, in queue order.
  for r in
    select b.id, b.user_id
    from public.bookings b
    where b.session_id = new.id
      and b.status = 'waitlisted'
      and (b.payment_status = 'paid'
           or b.package_purchase_id is not null
           or exists (select 1 from public.make_up_tokens t
                       where t.redeemed_booking_id = b.id and t.status = 'redeemed'))
    order by b.waitlist_position nulls last, b.created_at
    limit v_free
  loop
    update public.bookings set status = 'confirmed', waitlist_position = null where id = r.id;
    insert into public.notifications (user_id, type, title, body, data)
    select r.user_id, 'waitlist_promoted', 'You''re off the waitlist! ' || E'\U0001F389',
           'A spot opened up and your place is now confirmed.',
           public.session_email_details(new.id) || jsonb_build_object(
             'url', '/profile?tab=bookings', 'booking_id', r.id)
    where r.user_id is not null;
  end loop;

  -- Then everyone still waiting is told, if a seat is left (free class or
  -- paid). notify_waitlist_all_open reads the session's capacity, and this is
  -- an AFTER trigger, so it sees the new figure.
  perform public.notify_waitlist_all_open(new.id);
  return new;
end;
$function$;

commit;
