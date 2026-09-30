-- Notify parents of Wix-side changes that the session trigger never saw.
--
-- notify_session_rescheduled (00044/00126) fires on activity_sessions.starts_at
-- / location_id. A Wix-linked activity's location does NOT live on its
-- sessions: lib/wix/sync.ts keeps it on `activities` (location_id, address,
-- postal_code) from the Wix service, so a vendor moving their venue in Wix
-- changed what every booked parent turns up to and emailed nobody. Likewise a
-- service deleted on Wix only got wix_missing_since + unpublished, with its
-- bookings left alone and no word to the parents holding them.
--
-- Both are DB triggers rather than sync code so they fire for every writer
-- (15-minute cron, the vendor's "Sync services" button, the import picker).
-- They reuse the existing `session_rescheduled` notification type, so the
-- in-app notice and the branded "review the details" email need no new
-- template.

-- Bookings a parent still holds on a session that has not finished. A COURSE's
-- booking points at a whole-run anchor row whose starts_at is already past
-- mid-run, hence ends_at.
create or replace function public.wix_activity_live_bookings(p_activity_id uuid)
returns table (booking_id uuid, user_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select b.id, b.user_id
  from public.bookings b
  join public.activity_sessions s on s.id = b.session_id
  where s.activity_id = p_activity_id
    and s.status is distinct from 'cancelled'
    and coalesce(s.ends_at, s.starts_at) > now()
    and b.user_id is not null
    and b.status in ('pending', 'confirmed', 'waitlisted');
$$;

-- 1. Location changed on a Wix-linked activity.
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
      || coalesce(' (' || new.address || ')', '') || ' — please review the new details.',
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

drop trigger if exists on_wix_activity_location_changed on public.activities;
create trigger on_wix_activity_location_changed
  after update of address, location_id on public.activities
  for each row execute function public.notify_wix_activity_location_changed();

-- 2. Wix-linked service no longer on the connected Wix account. The sync
-- cannot tell "deleted on Wix" from "vendor reconnected a different site", so
-- the wording stays the same generic "review your booking"; it is de-duplicated
-- per booking so a flapping wix_missing_since cannot email the same parent
-- repeatedly.
create or replace function public.notify_wix_service_removed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.wix_service_id is null
     or old.wix_missing_since is not null
     or new.wix_missing_since is null then
    return new;
  end if;

  insert into public.notifications (user_id, type, title, body, data)
  select
    lb.user_id,
    'session_rescheduled',
    'Activity no longer available',
    coalesce(new.title, 'An activity') || ' has been changed or removed by the provider — please review your booking and contact them if needed.',
    jsonb_build_object(
      'url', '/profile?tab=bookings',
      'booking_id', lb.booking_id,
      'activity_name', new.title,
      'reason', 'service_removed'
    )
  from public.wix_activity_live_bookings(new.id) lb
  where not exists (
    select 1
    from public.notifications n
    where n.user_id = lb.user_id
      and n.type = 'session_rescheduled'
      and n.data ->> 'booking_id' = lb.booking_id::text
      and n.data ->> 'reason' = 'service_removed'
      and n.created_at > now() - interval '7 days'
  );

  return new;
end;
$$;

drop trigger if exists on_wix_service_removed on public.activities;
create trigger on_wix_service_removed
  after update of wix_missing_since on public.activities
  for each row execute function public.notify_wix_service_removed();

-- Internal helper for the two triggers above. security definer + returns
-- booking/user ids, so it must not be callable through the public API.
revoke all on function public.wix_activity_live_bookings(uuid) from public, anon, authenticated;
revoke all on function public.notify_wix_activity_location_changed() from public, anon, authenticated;
revoke all on function public.notify_wix_service_removed() from public, anon, authenticated;
