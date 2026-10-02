-- 00213_activity_address_follows_venue.sql
--
-- A class's address must follow its venue, whoever changes it.
--
-- What parents see for a class comes from the class's OWN stored copy of the address
-- (activities.address / postal_code / latitude / longitude): the activity page, Explore, the area
-- filter and the map pin all read it. Those columns were only ever copied from the venue
-- (provider_locations) when the class was created, so:
--
--   * editing a venue's address, postal code or pin changed the venue and left every class that
--     uses it showing the old place (the admin portal and the vendor's own Settings -> Locations
--     both did this);
--   * switching a class to a different venue left it on the old venue's address.
--
-- Two triggers close both gaps for every writer (admin portal, vendor portal, Wix sync), so no
-- single code path has to remember to do it:
--
--   1. venue changed   -> its classes take the venue's new address / postal code / pin;
--   2. class moved to another venue (or created on one) -> it takes that venue's address and area.
--
-- Classes held at a customer's own address (is_custom_location) are left alone. When a venue's
-- address changes but its pin is not known yet, the classes' old pin is cleared rather than kept:
-- it belongs to the old place, and the search falls back to the business's own pin. Nothing is
-- backfilled: real vendors' classes already agree with their venues today, and a bulk update
-- would fire the "activity location changed" notifications (00202) for no reason.
--
-- Idempotent.

begin;

-- 1. A venue changed: bring its classes with it.
create or replace function public.sync_activities_from_location()
returns trigger
language plpgsql
as $$
begin
  if new.address is not distinct from old.address
     and new.postal_code is not distinct from old.postal_code
     and new.latitude is not distinct from old.latitude
     and new.longitude is not distinct from old.longitude then
    return new;
  end if;

  update public.activities a
     set address     = new.address,
         postal_code = new.postal_code,
         latitude    = new.latitude,
         longitude   = new.longitude
   where a.location_id = new.id
     and coalesce(a.is_custom_location, false) = false
     and (a.address     is distinct from new.address
       or a.postal_code is distinct from new.postal_code
       or a.latitude    is distinct from new.latitude
       or a.longitude   is distinct from new.longitude);

  return new;
end;
$$;

drop trigger if exists provider_locations_sync_activities_trg on public.provider_locations;
create trigger provider_locations_sync_activities_trg
  after update of address, postal_code, latitude, longitude on public.provider_locations
  for each row execute function public.sync_activities_from_location();

-- 2. A class was put on a venue (or moved to another one): take that venue's address.
create or replace function public.copy_location_to_activity()
returns trigger
language plpgsql
as $$
declare
  v_loc public.provider_locations%rowtype;
  v_lat double precision;
  v_lng double precision;
  v_provider_region text;
begin
  if new.location_id is null or coalesce(new.is_custom_location, false) then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.location_id is not distinct from old.location_id then
    return new;   -- only when the venue itself changes, so a deliberate address edit is not overwritten
  end if;

  select * into v_loc from public.provider_locations where id = new.location_id;
  if not found or v_loc.address is null then
    return new;   -- nothing to copy; keep what the class has
  end if;

  new.address     := v_loc.address;
  new.postal_code := v_loc.postal_code;
  new.latitude    := v_loc.latitude;
  new.longitude   := v_loc.longitude;

  -- The area (region) filter reads activities.region, which activities_region_trg derives from the
  -- postal code. That trigger only fires for columns named in the UPDATE statement, and this change
  -- happens inside a BEFORE trigger, so work the region out here too, by the same rule (00096).
  select coalesce(new.latitude, p.latitude), coalesce(new.longitude, p.longitude), p.region
    into v_lat, v_lng, v_provider_region
    from public.providers p where p.id = new.provider_id;
  new.region := coalesce(
    case
      when new.postal_code is not null then public.sg_region(new.postal_code, v_lat, v_lng)
      else public.sg_region(new.postal_code, new.latitude, new.longitude)
    end,
    v_provider_region
  );
  return new;
end;
$$;

drop trigger if exists activities_copy_location_trg on public.activities;
create trigger activities_copy_location_trg
  before insert or update of location_id on public.activities
  for each row execute function public.copy_location_to_activity();

commit;
