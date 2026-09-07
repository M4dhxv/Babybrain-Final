-- 00105_promote_absorbs_capacity_on_pay.sql
--
-- "Promote + notify" (00101) on an unpaid booking sets waitlist_pay_invited
-- and sends the family a "Pay now" link, but doesn't hold a seat or touch
-- capacity. So a promoted family can pay even when the class is full (5/5) —
-- and until now that just silently oversold: the class showed 6/5.
--
-- Desired behaviour (owner): Promote leaves capacity exactly where it is.
-- Other parents still see the class as full and can't book. But the instant
-- the promoted family actually pays, the class grows by one seat to take
-- them — so it lands at an honest 6/6, not 6/5.
--
-- This trigger is the single choke point: any path that moves a booking from
-- 'waitlisted' to 'confirmed'/'pending' (Stripe webhook, return-from-Stripe
-- reconcile, or a settled Promote) passes through here. If letting that seat
-- in would exceed the session's capacity, capacity is lifted to fit exactly
-- that seat. When there was a genuine vacancy (a cancellation, a capacity
-- increase, the normal auto-promote) the check is a no-op.
--
-- Idempotent: it keys off the actual status transition, so a webhook retry
-- (row already 'confirmed') does nothing. No schema change.

begin;

create or replace function public.absorb_over_capacity_claim()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_cap   int;
  v_taken int;
begin
  -- Only the waitlist -> in transition.
  if not (old.status = 'waitlisted' and new.status in ('confirmed', 'pending')) then
    return new;
  end if;

  select capacity into v_cap
  from public.activity_sessions
  where id = new.session_id;

  -- Uncapped session: nothing to absorb.
  if v_cap is null then
    return new;
  end if;

  -- Live seats on the session other than this one (this is an AFTER trigger,
  -- so new.id is already counted in 'confirmed').
  select count(*) into v_taken
  from public.bookings
  where session_id = new.session_id
    and status in ('pending', 'confirmed')
    and id <> new.id;

  -- Letting this seat in tips the session over its capacity -> grow capacity
  -- to fit exactly this seat. A real vacancy leaves this untouched.
  if v_taken + 1 > v_cap then
    update public.activity_sessions
    set capacity = v_taken + 1
    where id = new.session_id;
  end if;

  return new;
end;
$$;

drop trigger if exists after_claim_absorb_capacity on public.bookings;
create trigger after_claim_absorb_capacity
  after update of status on public.bookings
  for each row execute function public.absorb_over_capacity_claim();

insert into supabase_migrations.schema_migrations (version, name)
values ('00105','promote_absorbs_capacity_on_pay')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
