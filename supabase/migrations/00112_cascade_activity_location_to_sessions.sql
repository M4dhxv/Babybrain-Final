-- 00112_cascade_activity_location_to_sessions.sql
--
-- QA: "'Your booking is confirmed' / 'upcoming booking' email doesn't pull the
-- right location — Beach wanderers is at a newly added location 'Palawan' but
-- the email says the Demo Studio."
--
-- session_email_details() (00048/00102) resolves the venue as
-- coalesce(s.location_id, a.location_id) -> provider_locations. The session
-- wins, which is correct for a deliberate per-session venue (00074). The bug
-- is that the session was never a deliberate override: the vendor SPA's
-- "schedule sessions" form pre-fills the venue from the activity and writes
-- that copy onto every session it creates. So when the vendor later moves the
-- activity to a new location, its existing sessions keep an explicit copy of
-- the OLD one, and every confirmation / reminder email for those sessions
-- names the wrong place.
--
-- Same shape as 00093's provider-address cascade, one level down:
--
-- 1. cascade_activity_location() — when an activity's location_id changes,
--    carry it onto the sessions that were merely holding a copy of the old
--    one (s.location_id = old.location_id). A session pointed at some other
--    venue is a real override and is left alone; a null session already
--    inherits through the coalesce and needs no write.
--
-- 2. One-time backfill for sessions that already drifted: an explicit
--    location that differs from their activity's current (non-null) one.
--    Scoped to a.location_id is not null so it never blanks a session that
--    is itself the only venue on record (e.g. Bharatanatyam Tots, whose
--    activity carries no location — those are untouched).
--
-- Currently 2 sessions, both BabyBrain Demo Provider: Beach wanderers
-- (-> Palawan, 4 bookings) and Rhythm Riders (-> Demo Studio Main, 0
-- bookings). A genuine per-session venue that this flattens can simply be
-- re-set on the session; from here on the SPA writes null for "same as the
-- activity", so only a real override carries a value.

begin;

create or replace function public.cascade_activity_location()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if new.location_id is not distinct from old.location_id then
    return new;
  end if;

  update public.activity_sessions s
  set location_id = new.location_id
  where s.activity_id = new.id
    and old.location_id is not null
    and s.location_id is not distinct from old.location_id;

  return new;
end;
$$;

comment on function public.cascade_activity_location() is
  'Carries an activity location change onto the sessions that were holding a '
  'copy of the old one, leaving a deliberate per-session venue alone.';

drop trigger if exists activities_location_cascade on public.activities;
create trigger activities_location_cascade
  after update of location_id on public.activities
  for each row execute function public.cascade_activity_location();

-- ---------------------------------------------------------------------------
-- One-time: sessions still holding a location their activity has moved on
-- from. Only where the activity has a location of its own to fall back to.
-- ---------------------------------------------------------------------------
update public.activity_sessions s
set location_id = a.location_id
from public.activities a
where a.id = s.activity_id
  and s.location_id is not null
  and a.location_id is not null
  and s.location_id <> a.location_id;

commit;
