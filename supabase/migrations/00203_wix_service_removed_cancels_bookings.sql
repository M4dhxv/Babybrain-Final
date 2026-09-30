-- A Wix service removed from the connected Wix account now CANCELS the
-- bookings parents hold on it, instead of only sending a generic notice.
--
-- 00202 sent a "please review" notification when lib/wix/sync.ts flagged an
-- activity wix_missing_since, but left the bookings confirmed on a service
-- that no longer exists. The existing cancel_wix_session() (00146) is the one
-- place a Wix-dropped session is cancelled: it marks the session cancelled and
-- cancels each live booking as a vendor cancellation, so the branded
-- class_cancelled email + in-app notification (notify_booking_cancelled, 00143)
-- and the credit / make-up token (compensate_cancelled_booking) all follow.
-- This trigger reuses it for every future session that still has a live
-- booking, so the generic notice is no longer needed (it would double up).
--
-- Only fires on the null -> set transition of wix_missing_since, so a service
-- that stays missing is not reprocessed on every sync. Sessions nobody has
-- booked are left as they are (nothing to tell anyone).
--
-- Also re-creates notify_wix_activity_location_changed (00202) with a plain
-- ASCII hyphen: its em dash was stored mangled (as "a-euro-dash") in the
-- notification body.

create or replace function public.notify_wix_service_removed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session uuid;
begin
  if new.wix_service_id is null
     or old.wix_missing_since is not null
     or new.wix_missing_since is null then
    return new;
  end if;

  -- A COURSE's booking points at a whole-run anchor row whose starts_at is
  -- already past mid-run, hence ends_at.
  for v_session in
    select s.id
    from public.activity_sessions s
    where s.activity_id = new.id
      and s.status is distinct from 'cancelled'
      and coalesce(s.ends_at, s.starts_at) > now()
      and exists (
        select 1 from public.bookings b
        where b.session_id = s.id
          and b.status in ('pending', 'confirmed', 'waitlisted')
      )
  loop
    perform public.cancel_wix_session(v_session);
  end loop;

  return new;
end;
$$;

create or replace function public.notify_wix_activity_location_changed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Only a real move between two known places: a first-time import, or Wix
  -- briefly returning no location (new side empty), must not email anyone.
  if new.wix_service_id is null
     or (old.address is null and old.location_id is null)
     or (new.address is null and new.location_id is null)
     or (new.address is not distinct from old.address
         and new.location_id is not distinct from old.location_id) then
    return new;
  end if;

  insert into public.notifications (user_id, type, title, body, data)
  select
    lb.user_id,
    'session_rescheduled',
    'Activity location changed',
    coalesce(new.title, 'An activity') || ' has a new location'
      || coalesce(' (' || new.address || ')', '') || ' - please review the new details.',
    jsonb_build_object(
      'url', '/profile?tab=bookings',
      'booking_id', lb.booking_id,
      'activity_name', new.title,
      'reason', 'location_changed'
    )
  from public.wix_activity_live_bookings(new.id) lb;

  return new;
end;
$$;

revoke all on function public.notify_wix_service_removed() from public, anon, authenticated;
revoke all on function public.notify_wix_activity_location_changed() from public, anon, authenticated;
