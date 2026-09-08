-- 00108_wix_class_promote_no_capacity_bump.sql
--
-- 00105 (absorb_over_capacity_claim): when a waitlisted booking is promoted
-- and paid on a full class, the session's capacity is lifted by one so the
-- claimed seat lands at an honest n+1 / n+1 rather than an oversold n+1 / n.
--
-- That is wrong for a Wix-linked CLASS. activity_sessions.capacity for a Wix
-- class is a mirror of Wix's own seat count, refreshed from Wix on every
-- /api/wix/slots fetch and the 5-minute sync. BabyBrain cannot write capacity
-- back to Wix, so bumping the mirror:
--   * is undone by the next sync within minutes (pointless churn), and
--   * fires on_session_capacity_increase (00100), which then invites /
--     auto-promotes more of the waitlist against a seat that does not exist
--     on Wix.
--
-- New behaviour for a Wix CLASS: the promoted + paid booking is confirmed and
-- simply carried over the mirrored capacity. Wix stays n/n; the extra paid
-- seats are BabyBrain's to hold and are shown on the vendor roster as
-- "+x held on BabyBrain". Native classes and independent (non-Wix) sessions
-- keep 00105's capacity-absorb behaviour exactly as-is.
--
-- Rebuilt in full from 00105's body; the only change is the Wix-CLASS guard.
-- Idempotent, no schema change.

begin;

create or replace function public.absorb_over_capacity_claim()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_cap       int;
  v_taken     int;
  v_wix_class boolean;
begin
  -- Only the waitlist -> in transition.
  if not (old.status = 'waitlisted' and new.status in ('confirmed', 'pending')) then
    return new;
  end if;

  select s.capacity,
         (a.wix_service_id is not null and a.wix_service_type = 'CLASS')
    into v_cap, v_wix_class
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  where s.id = new.session_id;

  -- Wix owns a Wix class's capacity and it cannot be written back — a
  -- promoted paid seat is carried over the mirrored capacity instead of
  -- inflating it (which the sync would only undo, and which would spuriously
  -- promote the rest of the queue). The seat stays 'confirmed'; the vendor
  -- roster surfaces the overflow.
  if coalesce(v_wix_class, false) then
    return new;
  end if;

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

insert into supabase_migrations.schema_migrations (version, name)
values ('00108','wix_class_promote_no_capacity_bump')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
