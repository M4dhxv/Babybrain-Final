-- 00266_activity_ticket_limits.sql
--
-- Issues sheet 28 Oct: "At the moment can't set a minimum or maximum for number of tickets sold per
-- booking ... if there is an activity which is a price for 2 kids then you can say the parent can't
-- book unless they select 2 tickets."
--
-- Two optional limits on an activity: the fewest and the most tickets (places) one booking may take.
-- NULL = no limit, which is how every existing activity behaves. The parent booking page uses them to
-- bound its ticket stepper and to refuse a basket outside the range. They sit beside the activity's
-- other booking rules (booking_cutoff_minutes, ...). Additive and nullable, so apps that don't know
-- about them keep working, and the vendor portal only writes them when a vendor sets one.
--
-- Idempotent.

begin;

alter table public.activities
  add column if not exists min_tickets_per_booking integer,
  add column if not exists max_tickets_per_booking integer;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'activities_ticket_limits_valid') then
    alter table public.activities
      add constraint activities_ticket_limits_valid check (
        (min_tickets_per_booking is null or min_tickets_per_booking between 1 and 20)
        and (max_tickets_per_booking is null or max_tickets_per_booking between 1 and 20)
        and (min_tickets_per_booking is null or max_tickets_per_booking is null
             or min_tickets_per_booking <= max_tickets_per_booking)
      );
  end if;
end $$;

comment on column public.activities.min_tickets_per_booking is
  'Fewest tickets one booking may take (NULL = no minimum). Enforced by the parent booking page.';
comment on column public.activities.max_tickets_per_booking is
  'Most tickets one booking may take (NULL = no maximum). Enforced by the parent booking page.';

notify pgrst, 'reload schema';

commit;
