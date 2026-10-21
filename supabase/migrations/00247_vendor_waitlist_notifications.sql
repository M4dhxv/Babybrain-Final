-- 00247_vendor_waitlist_notifications.sql
--
-- The vendor side of the waitlist (client, 2026-10-21):
--
--   1. A new "Someone joined your waitlist" notification (email + push) to the vendor's
--      team when a family joins a session's waitlist, so a vendor who can take more raises
--      the capacity — which itself tells everyone waiting a place is free (00197/00204).
--      Mirrors provider_booking_received: active team members only, never for a booking
--      the vendor typed in themselves (00184), one per multi-child booking (00228).
--
--   2. The vendor's Notifications feed reported a family leaving the waitlist as
--      "cancelled their booking". A cancelled waitlist place now has its own kind,
--      'waitlist_left' ("Teddy is no longer on the waitlist for …"); 'cancellation' is
--      only real bookings.
--
--   3. How a cancelled waitlist place is recognised, here and in the vendor portal: it
--      still carries its waitlist_position. Joining the waitlist sets it, cancelling keeps
--      it, and every promotion off the waitlist clears it (no confirmed booking on
--      production has one). The vendor's roster already returns waitlist_position, so the
--      Bookings page can keep these under Waitlist without any other change.
--      cancelled_from_status (00210) is corrected for the cancellations it had inferred
--      as "confirmed" before that column existed.
--
-- Idempotent.

begin;

-- 3. Correct the inferred origin of old waitlist cancellations (admin Metrics reads it too).
update public.bookings
   set cancelled_from_status = 'waitlisted'
 where status = 'cancelled'
   and waitlist_position is not null
   and cancelled_origin_inferred
   and cancelled_from_status is distinct from 'waitlisted';

-- 1. "Someone joined your waitlist".
create or replace function public.notify_provider_waitlist_joined()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_waiting int;
  v_name text;
begin
  -- The vendor's own offline record (no parent account) — same rule as 00184.
  if new.user_id is null and new.guest_name is not null then
    return new;
  end if;
  if new.status <> 'waitlisted' or new.provider_id is null
     or public.group_sibling_notified(new.booking_group_id, new.id, 'provider_waitlist_joined') then
    return new;
  end if;

  select count(*) into v_waiting
    from public.bookings b
   where b.session_id = new.session_id and b.status = 'waitlisted';

  select coalesce(c.name, new.guest_name, 'A family') into v_name
    from (select 1) x left join public.children c on c.id = new.child_id;

  insert into public.notifications (user_id, type, title, body, data)
  select m.user_id, 'provider_waitlist_joined', 'Someone joined your waitlist ⏳',
         v_name || ' joined the waitlist for ' || a.title || '. If you can take more, increase the capacity for this session.',
         public.session_email_details(new.session_id) || jsonb_build_object(
           -- The vendor portal uses hash routes (/vendor/#/…); its Bookings page opens this session
           -- with the family highlighted, on the Waitlist tab.
           'url', '/vendor/#/bookings?session=' || new.session_id || '&booking=' || new.id,
           'booking_id', new.id,
           'session_id', new.session_id,
           'child_name', v_name,
           'waiting_count', v_waiting)
    from public.provider_members m
    join public.activity_sessions s on s.id = new.session_id
    join public.activities a on a.id = s.activity_id
   where m.provider_id = new.provider_id and m.status = 'active';
  return new;
end;
$function$;

revoke all on function public.notify_provider_waitlist_joined() from public, anon, authenticated;

drop trigger if exists on_provider_waitlist_joined on public.bookings;
create trigger on_provider_waitlist_joined
  after insert on public.bookings
  for each row execute function public.notify_provider_waitlist_joined();

-- 2. The feed: cancelled waitlist places are 'waitlist_left', not 'cancellation' — but only for a
--    caller that asks (p_waitlist_left => true). A vendor portal built before this change has no
--    entry for 'waitlist_left' and its Notifications page throws on an unknown kind; vendors keep the
--    portal open for hours, so old code keeps running well after a deploy. Without the flag the
--    feed is exactly what it was (a cancelled waitlist place reads as 'cancellation'), so this
--    migration is safe to apply before, during or after the code ships.
drop function if exists public.provider_notification_feed(uuid, integer);
drop function if exists public.provider_notification_feed(uuid, integer, boolean);
create function public.provider_notification_feed(
  p_provider uuid,
  p_limit integer default 30,
  p_waitlist_left boolean default false
)
returns table (
  kind text,
  event_at timestamptz,
  actor_name text,
  activity_title text,
  detail text,
  booking_id uuid,
  session_id uuid,
  activity_id uuid,
  review_id uuid,
  token_id uuid
)
language plpgsql
stable security definer
set search_path = public
as $$
begin
  if p_provider not in (select public.user_provider_ids()) then
    raise exception 'not authorized';
  end if;

  return query
  select * from (
    (
      select 'booking'::text, b.created_at, coalesce(c.name, b.guest_name, 'Guest')::text, a.title, null::text,
             b.id, s.id, a.id, null::uuid, null::uuid
      from public.bookings b
      join public.activity_sessions s on s.id = b.session_id
      join public.activities a on a.id = s.activity_id
      left join public.children c on c.id = b.child_id
      where b.provider_id = p_provider and b.status in ('confirmed', 'completed')
      order by b.created_at desc
      limit p_limit
    )
    union all
    (
      select 'waitlist'::text, b.created_at, coalesce(c.name, b.guest_name, 'Guest')::text, a.title, null::text,
             b.id, s.id, a.id, null::uuid, null::uuid
      from public.bookings b
      join public.activity_sessions s on s.id = b.session_id
      join public.activities a on a.id = s.activity_id
      left join public.children c on c.id = b.child_id
      where b.provider_id = p_provider and b.status = 'waitlisted'
      order by b.created_at desc
      limit p_limit
    )
    union all
    (
      -- A real booking cancelled. (A cancelled waitlist place is the next branch.)
      select 'cancellation'::text, coalesce(b.cancelled_at, b.updated_at), coalesce(c.name, b.guest_name, 'Guest')::text, a.title, null::text,
             b.id, s.id, a.id, null::uuid, null::uuid
      from public.bookings b
      join public.activity_sessions s on s.id = b.session_id
      join public.activities a on a.id = s.activity_id
      left join public.children c on c.id = b.child_id
      where b.provider_id = p_provider and b.status = 'cancelled' and b.waitlist_position is null
      order by coalesce(b.cancelled_at, b.updated_at) desc
      limit p_limit
    )
    union all
    (
      select (case when p_waitlist_left then 'waitlist_left' else 'cancellation' end)::text, coalesce(b.cancelled_at, b.updated_at), coalesce(c.name, b.guest_name, 'Guest')::text, a.title, null::text,
             b.id, s.id, a.id, null::uuid, null::uuid
      from public.bookings b
      join public.activity_sessions s on s.id = b.session_id
      join public.activities a on a.id = s.activity_id
      left join public.children c on c.id = b.child_id
      where b.provider_id = p_provider and b.status = 'cancelled' and b.waitlist_position is not null
      order by coalesce(b.cancelled_at, b.updated_at) desc
      limit p_limit
    )
    union all
    (
      select 'review'::text, r.created_at, coalesce(par.full_name, 'A parent')::text, a.title, r.rating::text,
             null::uuid, null::uuid, a.id, r.id, null::uuid
      from public.reviews r
      join public.activities a on a.id = r.activity_id
      left join public.parent_profiles par on par.id = r.user_id
      where a.provider_id = p_provider
      order by r.created_at desc
      limit p_limit
    )
    union all
    (
      select 'token_issued'::text, t.created_at, coalesce(c.name, 'A family')::text, null::text, null::text,
             null::uuid, null::uuid, null::uuid, null::uuid, t.id
      from public.make_up_tokens t
      left join public.children c on c.id = t.child_id
      where t.provider_id = p_provider
        and not t.auto_issued
      order by t.created_at desc
      limit p_limit
    )
  ) feed
  order by 2 desc
  limit p_limit;
end;
$$;
revoke all on function public.provider_notification_feed(uuid, integer, boolean) from public, anon;
grant execute on function public.provider_notification_feed(uuid, integer, boolean) to authenticated;

notify pgrst, 'reload schema';

commit;
