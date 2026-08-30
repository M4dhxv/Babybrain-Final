-- 00070_wix_events_as_activities.sql
--
-- A synced Wix Event is now ALSO mirrored into `activities` (see
-- lib/wix/events-sync.ts) so it shows up in the exact same listing, search,
-- and activity detail/booking page every other activity already uses — no
-- new parent-facing pages. `wix_service_id` is deliberately left null on
-- these rows (only `wix_event_id` + `wix_service_type = 'EVENT'` identify
-- them) so every existing Wix *Bookings* code path, which gates purely on
-- `wix_service_id` being set (see app/api/wix/slots, frontends/parent/src/lib/data.ts),
-- continues to never see or touch an event-backed activity.
--
-- The booking step still writes a real `bookings` row per ticket (via
-- lib/wix/finalize-event-checkout.ts and app/api/wix/events/rsvp) purely so
-- "My Bookings" and the vendor roster keep working unmodified — the
-- authoritative order record stays event_ticket_orders (00069); `bookings`
-- here is a display-only mirror, same relationship activity_sessions/bookings
-- already have to the live Wix Bookings slot data.
-- Idempotent.

-- wix_service_type's check constraint was added inline on the column
-- (00056_wix_class_services.sql), so it has Postgres's default single-column
-- name — found dynamically rather than assumed, so this can't silently
-- leave the old 3-value constraint in place under a name this migration
-- guessed wrong.
do $$
declare
  con_name text;
begin
  select con.conname into con_name
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_attribute att on att.attrelid = rel.oid and att.attnum = any(con.conkey)
  where rel.relname = 'activities'
    and att.attname = 'wix_service_type'
    and con.contype = 'c'
  limit 1;

  if con_name is not null then
    execute format('alter table public.activities drop constraint %I', con_name);
  end if;

  alter table public.activities
    add constraint activities_wix_service_type_check
    check (wix_service_type in ('APPOINTMENT', 'CLASS', 'COURSE', 'EVENT'));
end $$;

alter table public.activities
  add column if not exists wix_event_id uuid references public.wix_events (id) on delete set null;
create index if not exists activities_wix_event_id_idx
  on public.activities (wix_event_id) where wix_event_id is not null;

-- Which ticket type a booking row corresponds to, for events with more than
-- one (e.g. General Admission vs VIP) — null for every non-event booking.
alter table public.bookings
  add column if not exists wix_ticket_type_id uuid references public.event_ticket_types (id);

-- wix_booking_id (00055) already means "this booking's identifier on the
-- Wix side" — reused as-is to hold the Wix *order number* for an event
-- ticket rather than adding a parallel column for the same concept.
