-- 00107_no_waitlist_for_wix_events_and_courses.sql
--
-- Wix Events and Wix Bookings COURSE services never use BabyBrain's local
-- waitlist. For both, Wix owns the remaining-capacity count:
--   * an event ticket is held by a live Wix reservation, the authoritative
--     availability check (app/api/wix/events/{checkout,rsvp});
--   * a course seat is checked against Wix's own `remainingCapacity` before
--     the local `bookings` row is ever written (resolveWixSlot in
--     lib/wix/sync.ts).
-- The local `activity_sessions.capacity` mirror only exists so the vendor
-- roster / Schedule can show a number — it is not the gate. So the only way
-- handle_booking_insert ever flips one of these rows to 'waitlisted' is a
-- stale-count race, and the product decision is that these two types simply
-- have no waitlist: a full course shows the next date with spots, a sold-out
-- event shows a disabled "Sold out".
--
-- Wix *CLASS* (weekly recurring) and native BabyBrain activities are
-- unaffected — they keep the local capacity -> waitlist behaviour.
--
-- 1. handle_booking_insert: skip the capacity -> waitlist branch when the
--    session's activity is a Wix EVENT or COURSE. The row keeps the status it
--    came in with (pending / confirmed).
-- 2. event_ticket_types.sold_out: persisted from Wix's own
--    salesDetails.soldOut (lib/wix/events-sync.ts) so the parent booking UI
--    can render a disabled "Sold out" state instead of "0 spots".
-- 3. Retire any waitlisted bookings that already exist against an
--    EVENT/COURSE session — no flow can promote them any more, so they would
--    otherwise be permanent dead cards in the parent's "My Bookings". These
--    rows are always unpaid (00100: you pay to claim a seat when it opens),
--    so compensate_cancelled_booking is a no-op for them and no credit or
--    make-up token is minted; the parent does get the standard
--    "booking cancelled" notification.

begin;

alter table public.event_ticket_types
  add column if not exists sold_out boolean not null default false;

-- Rebuilt from 00008's body; the only change is the EVENT/COURSE guard on the
-- capacity -> waitlist branch.
create or replace function public.handle_booking_insert()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_capacity int;
  v_taken int;
  v_provider uuid;
  v_wix_type text;
begin
  select a.provider_id, s.capacity, a.wix_service_type
    into v_provider, v_capacity, v_wix_type
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  where s.id = new.session_id;

  new.provider_id := coalesce(new.provider_id, v_provider);

  -- Wix Events and Wix COURSE enrolments have no local waitlist — Wix owns
  -- their remaining capacity and the booking only reaches here once Wix has
  -- already accepted it. Leave the incoming status untouched.
  if v_capacity is not null and coalesce(v_wix_type, '') not in ('EVENT', 'COURSE') then
    select count(*) into v_taken from public.bookings
    where session_id = new.session_id and status in ('pending','confirmed');
    if v_taken >= v_capacity then
      new.status := 'waitlisted';
      select coalesce(max(waitlist_position), 0) + 1 into new.waitlist_position
      from public.bookings where session_id = new.session_id and status = 'waitlisted';
    end if;
  end if;
  return new;
end;
$$;

-- One-off cleanup of rows stranded by the old behaviour.
update public.bookings b
set status = 'cancelled'
from public.activity_sessions s
join public.activities a on a.id = s.activity_id
where b.session_id = s.id
  and b.status = 'waitlisted'
  and a.wix_service_type in ('EVENT', 'COURSE');

insert into supabase_migrations.schema_migrations (version, name)
values ('00107','no_waitlist_for_wix_events_and_courses')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
