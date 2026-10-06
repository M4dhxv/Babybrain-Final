-- 00224_waitlist_dedupe_per_event.sql
--
-- "A parent cancels, a spot opens, and the waitlist gets no email."
--
-- notify_waitlist_all_open (00204) skips anyone who already has a
-- 'waitlist_available' notification for the session in the last 10 MINUTES.
-- That window was meant to collapse the duplicate calls ONE event makes (a
-- party of two cancelling in one statement fires the trigger twice), but it
-- also swallowed every genuinely separate event: a vendor "Promote" writes the
-- same notification type for the same session, so a parent who cancelled a few
-- minutes after a promote (or after an earlier cancellation) freed a real seat
-- and nobody was told.
--
-- notifications.created_at defaults to now(), which is the TRANSACTION start
-- time, so the rows one event writes share an identical timestamp. De-dupe on
-- that instead of a time window: same transaction = same event = one email;
-- any later transaction freeing a seat always emails again.
--
-- Everything else is 00204's function verbatim. Idempotent.

begin;

create or replace function public.notify_waitlist_all_open(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r        record;
  v_cap    int;
  v_taken  int;
begin
  select s.capacity into v_cap from public.activity_sessions s where s.id = p_session_id;
  if not found then return; end if;

  -- No free seat (someone else already took it): nothing to offer.
  select count(*) into v_taken from public.bookings b
   where b.session_id = p_session_id and b.status in ('pending', 'confirmed');
  if v_cap is not null and v_taken >= v_cap then return; end if;

  for r in
    select distinct on (b.user_id) b.id
      from public.bookings b
     where b.session_id = p_session_id
       and b.status = 'waitlisted'
       and b.user_id is not null
       and not (b.payment_status = 'paid'
                or b.package_purchase_id is not null
                or exists (select 1 from public.make_up_tokens t
                            where t.redeemed_booking_id = b.id and t.status = 'redeemed'))
       -- Collapses duplicate calls from ONE event (same transaction) only.
       and not exists (
             select 1 from public.notifications n
              where n.user_id = b.user_id
                and n.type = 'waitlist_available'
                and n.data ->> 'session_id' = p_session_id::text
                and n.created_at = now())
     order by b.user_id, b.waitlist_position nulls last, b.created_at
  loop
    perform public.notify_waitlist_spot_open(r.id);
  end loop;
end;
$function$;

revoke all on function public.notify_waitlist_all_open(uuid) from public, anon, authenticated;

commit;
