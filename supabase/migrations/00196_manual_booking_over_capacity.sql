-- 00196_manual_booking_over_capacity.sql
--
-- A vendor adding a manual booking (phone / walk-in) to a FULL native session
-- was told "increase the capacity". But raising capacity fires
-- on_session_capacity_increase (00100), which immediately offers every new seat
-- to the waitlist — so the freed seat went to a waitlisted parent, not to the
-- booking the vendor was trying to record.
--
-- add_manual_booking_over_capacity() does the whole thing atomically, under the
-- session-row lock handle_booking_insert (00156) also takes:
--   1. if the session is full (pending + confirmed >= capacity), raise
--      capacity to seats-taken + 1 — with the waitlist offer suppressed for
--      that one change (transaction-local setting, see below);
--   2. insert the manual booking, which now fits and stays 'confirmed'.
-- Waitlisted families are untouched: no email, no promotion, same queue order.
--
-- notify_waitlist_on_capacity_increase() is 00102's body verbatim plus one
-- early return when bb.skip_waitlist_offer is 'on'. The setting is
-- transaction-local (set_config(..., true)) and reset right after the update,
-- so it cannot leak into any other write.
--
-- Callable by service_role only (the vendor API route authorises the provider
-- role first). Native sessions only — the route refuses Wix-linked ones, whose
-- capacity Wix owns. Idempotent.

begin;

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
      perform public.notify_waitlist_spot_open(r.id);
    end if;
  end loop;

  return new;
end;
$$;

create or replace function public.add_manual_booking_over_capacity(
  p_session_id uuid,
  p_name text,
  p_contact text,
  p_paid boolean
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_cap int;
  v_taken int;
  v_waitlisted int;
  v_raised boolean := false;
  v_id uuid;
  v_status text;
begin
  -- Same lock handle_booking_insert takes, held to the end of this transaction.
  select s.capacity into v_cap
  from public.activity_sessions s
  where s.id = p_session_id
  for update;
  if not found then
    raise exception 'Session not found';
  end if;

  if v_cap is not null then
    select count(*) filter (where b.status in ('pending', 'confirmed')),
           count(*) filter (where b.status = 'waitlisted')
      into v_taken, v_waitlisted
    from public.bookings b
    where b.session_id = p_session_id;

    if v_taken >= v_cap then
      perform set_config('bb.skip_waitlist_offer', 'on', true);
      update public.activity_sessions set capacity = v_taken + 1 where id = p_session_id;
      perform set_config('bb.skip_waitlist_offer', 'off', true);
      v_raised := true;
    end if;
  end if;

  insert into public.bookings (session_id, guest_name, guest_contact, payment_status, status)
  values (p_session_id, p_name, p_contact, case when p_paid then 'paid' else 'none' end, 'confirmed')
  returning id, status into v_id, v_status;

  return jsonb_build_object(
    'id', v_id,
    'status', v_status,
    'capacity_increased', v_raised,
    'waitlisted', coalesce(v_waitlisted, 0)
  );
end;
$$;

revoke all on function public.add_manual_booking_over_capacity(uuid, text, text, boolean)
  from public, anon, authenticated;
grant execute on function public.add_manual_booking_over_capacity(uuid, text, text, boolean)
  to service_role;

notify pgrst, 'reload schema';

commit;
