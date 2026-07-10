-- 00024_auto_confirm_free_bookings.sql
-- Free classes have no payment step, so a parent's direct booking should be
-- CONFIRMED immediately rather than sitting at 'pending' forever. Previously
-- enforce_booking_insert_defaults() forced every client booking to 'pending',
-- so vendors never saw bookings (the vendor UI shows confirmed/completed only)
-- and could not take attendance. Paid classes still stay 'pending' until the
-- Stripe webhook (service_role) confirms on payment.
--
-- Also fixes a latent bug: the old function nulled waitlist_position even for
-- rows the capacity trigger (handle_booking_insert) had just placed on the
-- waitlist, wiping their server-computed queue position. We now preserve it.

create or replace function public.enforce_booking_insert_defaults()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_price numeric;
begin
  -- Only the server (service role: Stripe webhook / trusted route) may set
  -- payment state or amount. Everyone else gets safe defaults regardless of
  -- what they submitted.
  if coalesce(auth.role(), '') <> 'service_role' then
    new.payment_status := 'none';
    new.amount := null;
    new.stripe_payment_intent := null;

    -- Rows the capacity trigger already placed on the waitlist keep their
    -- server-computed status + position; never trust a client-supplied one
    -- for non-waitlisted rows.
    if new.status = 'waitlisted' then
      null; -- preserve status + waitlist_position set by handle_booking_insert
    else
      new.waitlist_position := null;

      -- Look up the activity price for this session to decide the outcome.
      select a.price into v_price
      from public.activity_sessions s
      join public.activities a on a.id = s.activity_id
      where s.id = new.session_id;

      if coalesce(v_price, 0) = 0 then
        new.status := 'confirmed';   -- free class: nothing to pay, confirm now
      else
        new.status := 'pending';     -- paid class: Stripe webhook confirms later
      end if;
    end if;
  end if;
  return new;
end;
$function$;
