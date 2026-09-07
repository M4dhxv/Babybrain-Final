-- 00102_fix_ambiguous_status_in_capacity_trigger.sql
--
-- notify_waitlist_on_capacity_increase (00090, refined in 00100) is a trigger
-- on activity_sessions, which has its own `status` column — so inside the
-- function NEW.status is in scope. The count query read from public.bookings
-- with a bare `status`:
--
--   where session_id = new.id and status in ('pending', 'confirmed')
--
-- which Postgres can't resolve — `bookings.status` or the trigger row's
-- `activity_sessions.status`? Every capacity change (a vendor edit, or the
-- Wix sync cron upserting a session) raised `column reference "status" is
-- ambiguous` and the write failed.
--
-- Fix: alias the table and qualify every column. Same for the queue loop's
-- select, which was already qualified but is restated here for one clean
-- definition.

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

notify pgrst, 'reload schema';

commit;
