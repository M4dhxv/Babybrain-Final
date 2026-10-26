-- 00254_session_venues_join_activity_locations.sql
--
-- A venue picked on a single session (Manage schedule -> a session's own
-- location, which vendors have always been able to do) never reached
-- activity_locations, so a class running at three venues through its sessions
-- still looked single-venue to parents: no "Venue +N" on the Explore card, no
-- "Also at N other locations" on the activity page, and the vendor's activity
-- editor listed no extra venues.
--
-- From now on a session's venue is also one of the activity's venues:
--  * a trigger adds it to activity_locations (no price of its own, so the
--    rule in 00250 falls through to the activity price) whenever a session
--    gets a location_id;
--  * existing sessions are backfilled once.
-- Additive: nothing the deployed portals write changes. A venue the vendor
-- later removes from the activity's list while no session uses it stays gone.
--
-- Idempotent.

begin;

create or replace function public.sync_session_venue_to_activity_locations()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.location_id is null or new.activity_id is null then
    return null;
  end if;
  -- This only tidies a list for parents. It must never be the reason a vendor
  -- cannot save a session, so any failure here is swallowed.
  begin
  insert into public.activity_locations (activity_id, location_id, position)
  select new.activity_id, new.location_id,
         coalesce((select max(al.position) + 1 from public.activity_locations al
                   where al.activity_id = new.activity_id), 0)
  where exists (select 1
                from public.activities a
                join public.provider_locations pl on pl.provider_id = a.provider_id
                where a.id = new.activity_id and pl.id = new.location_id
                  and a.wix_service_id is null and a.wix_event_id is null and a.wix_series_id is null)
  on conflict (activity_id, location_id) do nothing;
  exception when others then
    null;
  end;
  return null;
end;
$$;
revoke all on function public.sync_session_venue_to_activity_locations() from public, anon, authenticated;

drop trigger if exists activity_sessions_sync_venue on public.activity_sessions;
create trigger activity_sessions_sync_venue
  after insert or update of location_id on public.activity_sessions
  for each row when (new.location_id is not null)
  execute function public.sync_session_venue_to_activity_locations();

-- Backfill: every venue an upcoming session already runs at.
insert into public.activity_locations (activity_id, location_id, position)
select d.activity_id, d.location_id,
       coalesce((select max(al.position) from public.activity_locations al where al.activity_id = d.activity_id), 0)
         + row_number() over (partition by d.activity_id order by d.location_id)
from (
  select distinct s.activity_id, s.location_id
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  join public.provider_locations pl on pl.id = s.location_id and pl.provider_id = a.provider_id
  where s.location_id is not null
    and s.starts_at > now()
    and a.wix_service_id is null and a.wix_event_id is null and a.wix_series_id is null
) d
on conflict (activity_id, location_id) do nothing;

commit;

notify pgrst, 'reload schema';
