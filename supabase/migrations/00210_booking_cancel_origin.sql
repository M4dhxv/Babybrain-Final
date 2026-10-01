-- 00210_booking_cancel_origin.sql
--
-- Remember what state a booking was in when it was cancelled.
--
-- The admin Metrics "cancellation rate" should only count bookings cancelled
-- after they were confirmed or paid. A booking cancelled while still pending
-- (an abandoned or expired checkout) or while waitlisted was never a real
-- booking. The database only kept the final status, so that couldn't be told
-- apart. This records, at the moment a booking becomes 'cancelled', the status
-- and payment status it had just before.
--
-- Existing cancelled rows are backfilled by inference and flagged
-- cancelled_origin_inferred = true: a priced booking with no payment and no
-- package credit is treated as having been pending; everything else as
-- confirmed. Nothing else about bookings changes.
--
-- Idempotent.

begin;

alter table public.bookings
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancelled_from_status text,
  add column if not exists cancelled_from_payment text,
  add column if not exists cancelled_origin_inferred boolean not null default false;

comment on column public.bookings.cancelled_from_status is
  'Booking status immediately before it was cancelled (pending, waitlisted, confirmed, completed). Used by admin Metrics so cancellations from pending/waitlist do not count in the cancellation rate.';
comment on column public.bookings.cancelled_from_payment is
  'payment_status immediately before the booking was cancelled.';
comment on column public.bookings.cancelled_origin_inferred is
  'true = backfilled by inference for bookings cancelled before this column existed.';

create or replace function public.record_booking_cancel_origin()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    new.cancelled_at := now();
    new.cancelled_from_status := old.status;
    new.cancelled_from_payment := old.payment_status;
    new.cancelled_origin_inferred := false;
  end if;
  return new;
end;
$$;

drop trigger if exists booking_record_cancel_origin on public.bookings;
create trigger booking_record_cancel_origin
  before update of status on public.bookings
  for each row execute function public.record_booking_cancel_origin();

-- Backfill what already exists.
update public.bookings
   set cancelled_at = coalesce(cancelled_at, updated_at),
       cancelled_from_payment = coalesce(cancelled_from_payment, payment_status),
       cancelled_from_status = case
         when payment_status in ('paid', 'refunded') then 'confirmed'
         when coalesce(amount, 0) > 0 and package_purchase_id is null then 'pending'
         else 'confirmed'
       end,
       cancelled_origin_inferred = true
 where status = 'cancelled'
   and cancelled_from_status is null;

commit;
