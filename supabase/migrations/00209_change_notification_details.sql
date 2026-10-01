-- 00209_change_notification_details.sql
--
-- The "There has been a change to an activity you have booked" email only said
-- *that* something changed (00044/00126/00202) and linked to a bare
-- /profile?tab=bookings. It now shows what changed (old -> new) and the booking
-- itself, so the notifications carry that in `data`:
--
--   changes    [{label, old, new}]  only the fields that really differ
--   date_time  the booking's (new) date/time, SGT
--   address    the booking's (new) venue
--
-- Everything else about the triggers is unchanged: same events, same
-- recipients, same notification type, title and body. A notification written
-- before this (or one with no `changes`, e.g. service_removed) still renders
-- the original email wording; see lib/emails/render.ts session_rescheduled.

-- "Fri 2 Oct, 9:00 AM" in Singapore time.
create or replace function public.change_when(p_ts timestamptz)
returns text
language sql
immutable
as $$
  select to_char(p_ts at time zone 'Asia/Singapore', 'Dy FMDD Mon, FMHH12:MI AM');
$$;

-- Where a session actually happens: its own venue, else the activity's venue
-- row, else the activity's address text (same order the booking email uses).
create or replace function public.change_venue(p_location uuid, p_activity uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    nullif(concat_ws(', ', l.name, nullif(btrim(l.address), '')), ''),
    a.address
  )
  from public.activities a
  left join public.provider_locations l on l.id = coalesce(p_location, a.location_id)
  where a.id = p_activity;
$$;

revoke all on function public.change_venue(uuid, uuid) from public, anon, authenticated;

-- 1. A booked session's date/time or venue changed (native or Wix class).
create or replace function public.notify_session_rescheduled()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_title text;
  v_changes jsonb := '[]'::jsonb;
  v_old_venue text;
  v_new_venue text;
begin
  if new.starts_at is distinct from old.starts_at
     or new.location_id is distinct from old.location_id then
    select a.title into v_title from public.activities a where a.id = new.activity_id;

    v_old_venue := public.change_venue(old.location_id, new.activity_id);
    v_new_venue := public.change_venue(new.location_id, new.activity_id);

    if new.starts_at is distinct from old.starts_at then
      v_changes := v_changes || jsonb_build_array(jsonb_build_object(
        'label', 'Time', 'old', public.change_when(old.starts_at), 'new', public.change_when(new.starts_at)));
    end if;
    if v_new_venue is distinct from v_old_venue then
      v_changes := v_changes || jsonb_build_array(jsonb_build_object(
        'label', 'Venue', 'old', v_old_venue, 'new', v_new_venue));
    end if;

    insert into public.notifications (user_id, type, title, body, data)
    select
      b.user_id,
      'session_rescheduled',
      'Class details changed',
      coalesce(v_title, 'A class') || ' has been updated by the provider — please review the new details.',
      jsonb_build_object(
        'url', '/profile?tab=bookings',
        'booking_id', b.id,
        'activity_name', v_title,
        'changes', v_changes,
        'date_time', public.change_when(new.starts_at),
        'address', v_new_venue
      )
    from public.bookings b
    where b.session_id = new.id
      and b.user_id is not null
      and b.status in ('pending', 'confirmed', 'waitlisted');
  end if;
  return new;
end;
$$;

-- 2. A Wix-linked activity's venue moved (lives on `activities`, not sessions).
create or replace function public.notify_wix_activity_location_changed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_venue text;
  v_new_venue text;
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

  v_old_venue := coalesce(old.address, public.change_venue(old.location_id, new.id));
  v_new_venue := coalesce(new.address, public.change_venue(new.location_id, new.id));

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
      'reason', 'location_changed',
      'changes', jsonb_build_array(jsonb_build_object('label', 'Venue', 'old', v_old_venue, 'new', v_new_venue)),
      'address', v_new_venue
    ) || case
      -- A COURSE booking is a whole-run anchor whose start is not "the" date.
      when s.wix_slot_key is not null and s.wix_slot_key not like 'wixcourse:%'
        then jsonb_build_object('date_time', public.change_when(s.starts_at))
      else '{}'::jsonb
    end
  from public.wix_activity_live_bookings(new.id) lb
  join public.bookings b on b.id = lb.booking_id
  join public.activity_sessions s on s.id = b.session_id;

  return new;
end;
$$;

revoke all on function public.notify_wix_activity_location_changed() from public, anon, authenticated;
