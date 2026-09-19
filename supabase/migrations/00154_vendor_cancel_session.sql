-- 00154_vendor_cancel_session.sql
--
-- A vendor removing a session that already has bookings did nothing. The portal
-- ran a plain DELETE on activity_sessions; bookings.session_id references it
-- with no cascade (00001), so Postgres refused the delete, the portal ignored
-- the error, and the session, the parents' bookings and the emails all stayed
-- exactly as they were.
--
-- vendor_cancel_session() is the portal's cancel path, the same shape as
-- cancel_wix_session() (00146) but callable by the provider's own members:
-- marks the session cancelled (hidden from parents, nothing can be booked onto
-- it), then cancels every live booking AS A VENDOR CANCELLATION (cancelled_by
-- set to the caller), so the existing triggers send the branded class_cancelled
-- email + in-app notification (notify_booking_cancelled, 00143) and issue the
-- credit / make-up token (compensate_cancelled_booking). Waitlisted seats go
-- first so nobody is promoted into a dead class. Idempotent.

begin;

create or replace function public.vendor_cancel_session(p_session_id uuid)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_provider uuid;
  v_status   text;
  v_waitlist integer := 0;
  v_live     integer := 0;
begin
  select a.provider_id, s.status into v_provider, v_status
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  where s.id = p_session_id
  for update of s;

  if not found then
    raise exception 'Session not found';
  end if;

  if v_provider not in (select public.user_provider_ids()) then
    raise exception 'not authorized';
  end if;

  if v_status = 'cancelled' then
    return 0;
  end if;

  update public.activity_sessions set status = 'cancelled' where id = p_session_id;

  update public.bookings
     set status = 'cancelled',
         cancel_refund_mode = 'refund',
         cancel_reason = 'Class cancelled by the provider',
         cancelled_by = auth.uid()
   where session_id = p_session_id and status = 'waitlisted';
  get diagnostics v_waitlist = row_count;

  update public.bookings
     set status = 'cancelled',
         cancel_refund_mode = 'refund',
         cancel_reason = 'Class cancelled by the provider',
         cancelled_by = auth.uid()
   where session_id = p_session_id and status in ('pending', 'confirmed');
  get diagnostics v_live = row_count;

  return v_waitlist + v_live;
end;
$$;

revoke all on function public.vendor_cancel_session(uuid) from public, anon;
grant execute on function public.vendor_cancel_session(uuid) to authenticated;

notify pgrst, 'reload schema';

commit;
