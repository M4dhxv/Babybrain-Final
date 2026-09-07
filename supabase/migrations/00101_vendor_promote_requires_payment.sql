-- 00101_vendor_promote_requires_payment.sql
--
-- "Make the vendor promote also require payment on paid classes."
--
-- promote_waitlist_entry() (00090) confirmed a waitlisted booking outright,
-- no matter how it was — or wasn't — paid for. On a paid class that handed a
-- parent who never checked out a free confirmed seat, the one gap the
-- pay-aware cancellation / capacity paths (00090/00100) had left.
--
-- Now the vendor's "Promote" branches the same way:
--   * settled  (Stripe-paid, a package credit, a redeemed make-up token, or a
--              free class)  -> confirmed on the spot, "you're off the waitlist".
--   * unsettled (paid class, nothing paid)  -> the booking stays waitlisted,
--              `waitlist_pay_invited` is set, and the parent gets the same
--              "pay to claim" notification the automatic paths send. Their
--              Bookings page shows "Pay now" even though the class is full —
--              the vendor has explicitly offered them the seat — and
--              /api/bookings/checkout lets that payment through. On payment the
--              webhook confirms it as usual.

begin;

alter table public.bookings
  add column if not exists waitlist_pay_invited boolean not null default false;

comment on column public.bookings.waitlist_pay_invited is
  'A vendor promoted this waitlisted booking on a paid class that had not been '
  'paid for (00101). The parent is shown "Pay now" and the checkout route '
  'honours it even when the session is at capacity.';

create or replace function public.promote_waitlist_entry(p_booking_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_bk       public.bookings;
  v_settled  boolean;
begin
  select * into v_bk from public.bookings where id = p_booking_id;
  if v_bk.id is null then
    raise exception 'Booking not found';
  end if;
  if v_bk.provider_id is null or v_bk.provider_id not in (select public.user_manage_provider_ids()) then
    raise exception 'not authorized';
  end if;
  if v_bk.status <> 'waitlisted' then
    return;  -- already seated, cancelled, etc. — nothing to promote
  end if;

  v_settled :=
       v_bk.payment_status = 'paid'
    or v_bk.package_purchase_id is not null
    or exists (
         select 1 from public.make_up_tokens t
         where t.redeemed_booking_id = v_bk.id and t.status = 'redeemed')
    or coalesce(public.session_price(v_bk.session_id), 0) = 0;

  if v_settled then
    update public.bookings
    set status = 'confirmed', waitlist_position = null, waitlist_pay_invited = false
    where id = p_booking_id;

    insert into public.notifications (user_id, type, title, body, data)
    select user_id, 'waitlist_promoted', 'You''re off the waitlist! 🎉',
           'A spot opened up and your place is now confirmed.',
           public.session_email_details(v_bk.session_id) || jsonb_build_object(
             'url', '/profile?tab=bookings',
             'booking_id', p_booking_id)
    from public.bookings where id = p_booking_id and user_id is not null;
  else
    -- Paid class, not paid for: offer the seat, don't give it away.
    update public.bookings set waitlist_pay_invited = true where id = p_booking_id;
    perform public.notify_waitlist_spot_open(p_booking_id);
  end if;
end;
$$;

notify pgrst, 'reload schema';

commit;
