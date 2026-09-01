-- 00077_event_ticket_medical_disclosure.sql
--
-- Wix Events reuse the class booking form, so when the event's mirrored
-- activity has requires_medical_disclosure on, the parent is shown — and
-- forced to fill — a medical & health disclosure. The event checkout/RSVP
-- path then threw it away: event_ticket_orders had nowhere to store it and
-- the display `bookings` mirror never carried it, so the vendor roster
-- always showed "None provided".
--
-- Idempotent.

alter table public.event_ticket_orders
  add column if not exists medical_disclosure text;

comment on column public.event_ticket_orders.medical_disclosure is
  'Parent medical & health disclosure collected at ticket checkout/RSVP when the event''s activity requires one. Copied onto the display bookings rows by mirrorEventTicketAsBookings.';
