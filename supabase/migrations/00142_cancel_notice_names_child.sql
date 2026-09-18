-- 00142_cancel_notice_names_child.sql
--
-- In a party booking (00084) every seat is its own bookings row, all owned by
-- the booking parent. When ONE seat is cancelled while others in the party
-- are still live, the parent used to get the generic "Your booking for X has
-- been cancelled" notice/email — with nothing saying which child it was.
--
-- notify_booking_cancelled (00099) now names the child in that case: the
-- guest name for a guest seat, or the child's profile name for seat 1. A solo
-- booking, and a whole-party cancel (every seat flipped in one statement, so
-- no sibling is still live when the row triggers run), keep the existing
-- wording unchanged.
--
-- Idempotent.

begin;

create or replace function public.notify_booking_cancelled()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_title text;
  v_mode  text;
  v_child text;
  v_tail  text;
begin
  if new.status = 'cancelled'
     and old.status is distinct from 'cancelled'
     and new.user_id is not null then
    select a.title,
           coalesce(nullif(new.cancel_refund_mode, ''), a.cancellation_refund_mode, 'refund')
      into v_title, v_mode
    from public.activity_sessions s
    join public.activities a on a.id = s.activity_id
    where s.id = new.session_id;

    v_tail := case when v_mode = 'none'
      then 'This class is non-refundable, so no credit or make-up token was issued.'
      else 'Any refund follows the provider''s policy.'
    end;

    -- One seat of a still-live party: say whose spot it was.
    v_child := null;
    if new.booking_group_id is not null
       and exists (
         select 1 from public.bookings sib
         where sib.booking_group_id = new.booking_group_id
           and sib.id <> new.id
           and sib.status in ('pending', 'confirmed', 'waitlisted')
       ) then
      v_child := coalesce(
        nullif(btrim(new.guest_name), ''),
        (select c.name from public.children c where c.id = new.child_id),
        'Your child'
      );
    end if;

    if v_child is not null then
      insert into public.notifications (user_id, type, title, body, data)
      values (
        new.user_id,
        'booking_cancelled',
        'Booking cancelled for ' || v_child,
        v_child || '''s place in ' || coalesce(v_title, 'a class') ||
          ' has been cancelled. The rest of your booking is unchanged. ' || v_tail,
        jsonb_build_object('url', '/profile?tab=bookings', 'booking_id', new.id, 'child_name', v_child)
      );
    else
      insert into public.notifications (user_id, type, title, body, data)
      values (
        new.user_id,
        'booking_cancelled',
        'Booking cancelled',
        'Your booking for ' || coalesce(v_title, 'a class') || ' has been cancelled. ' || v_tail,
        jsonb_build_object('url', '/profile?tab=bookings', 'booking_id', new.id)
      );
    end if;
  end if;
  return new;
end;
$$;

notify pgrst, 'reload schema';

commit;
