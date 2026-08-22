-- Wix Bookings has two distinct systems: APPOINTMENT services (1:1 slots,
-- the service-availability/time-slots API) and CLASS/COURSE services (group
-- sessions with real capacity, the calendar/sessions/query API). The app
-- needs to know which one a linked activity uses to call the right Wix
-- endpoints — see lib/wix/client.ts.
-- Idempotent.

alter table public.activities
  add column if not exists wix_service_type text
    check (wix_service_type in ('APPOINTMENT', 'CLASS', 'COURSE'));
