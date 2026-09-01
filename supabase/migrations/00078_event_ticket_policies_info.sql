-- 00078_event_ticket_policies_info.sql
--
-- Same gap as 00077 (medical disclosure), for the other two things the
-- reused booking form collects: the provider's waivers/consents the parent
-- ticked, and their answer to the vendor's custom "info request" question.
-- The Wix event checkout/RSVP path stored neither, so the mirrored bookings
-- rows the vendor roster reads showed no waivers and no answer.
--
-- policies_accepted rides onto the mirrored bookings row and the existing
-- `booking_policy_record` AFTER-INSERT trigger fans it out into
-- booking_policy_acceptances (which is what the roster actually reads).
--
-- Idempotent.

alter table public.event_ticket_orders
  add column if not exists policies_accepted uuid[] not null default '{}',
  add column if not exists info_response text;

comment on column public.event_ticket_orders.policies_accepted is
  'Provider policy ids the parent accepted at ticket checkout/RSVP. Copied onto the mirrored bookings row, which records them in booking_policy_acceptances.';
comment on column public.event_ticket_orders.info_response is
  'Parent answer to the event activity''s info-request prompt, when it has one. Copied onto the mirrored bookings row.';
