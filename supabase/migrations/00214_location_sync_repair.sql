-- 00214_location_sync_repair.sql
--
-- Finishes 00213 (a class's address follows its venue). That migration fixed edits made from now
-- on, but three things kept an admin's venue / location change from reaching parents and vendors:
--
--   1. EXISTING classes were never reconciled. 00213 assumed they already agreed with their venues
--      and skipped a backfill. They did not: every venue edit made before it (e.g. Muckypups,
--      2 Oct 08:01-08:14) never reached its classes, and still has not. Reconciled here.
--
--   2. providers_address_cascade (cascade_provider_address) still rewrote ANY class of the business
--      that shared the old address or postal code, including classes on a venue of their own, which
--      is what the app-side rule in lib/admin-update-provider.ts says must not happen. It now only
--      moves classes that have no venue and are not at a customer's address.
--
--   3. Taking a class OFF its venue ("No fixed venue") left the old venue's address on it, so the
--      parent kept seeing the place it no longer runs. It now falls back to the business address,
--      unless the same write supplied an address of its own.
--
-- Also adds provider_locations.wix_address_locked: an admin who corrects the address of a venue that
-- is mirrored from Wix is overruling Wix on purpose, and the Wix sync must stop putting Wix's
-- address back (it did, every sync, silently).
--
-- Idempotent.

begin;

-- ---------------------------------------------------------------------------
-- 1. Wix venue address lock
-- ---------------------------------------------------------------------------
alter table public.provider_locations
  add column if not exists wix_address_locked boolean not null default false;

comment on column public.provider_locations.wix_address_locked is
  'Set when an admin edits the address of a Wix-linked venue. The Wix sync then keeps this venue''s stored address / postal code / pin instead of overwriting them with Wix''s.';

-- ---------------------------------------------------------------------------
-- 2. Business address change must not drag venue-based classes with it
-- ---------------------------------------------------------------------------
create or replace function public.cascade_provider_address()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if new.address     is not distinct from old.address
     and new.postal_code is not distinct from old.postal_code
     and new.latitude    is not distinct from old.latitude
     and new.longitude   is not distinct from old.longitude then
    return new;
  end if;

  update public.activities a
  set address     = new.address,
      postal_code = new.postal_code,
      latitude    = new.latitude,
      longitude   = new.longitude
  where a.provider_id = new.id
    -- A class on a venue follows that venue (sync_activities_from_location), and one held at a
    -- customer's address has none to follow. Only classes that were using the BUSINESS address move.
    and a.location_id is null
    and coalesce(a.is_custom_location, false) = false
    and (
      a.address is not distinct from old.address
      or (
        old.postal_code is not null
        and a.postal_code is not distinct from old.postal_code
        and a.address is not null
      )
    );

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. A class put on a venue takes its address; a class taken off one takes the business's
-- ---------------------------------------------------------------------------
create or replace function public.copy_location_to_activity()
returns trigger
language plpgsql
as $$
declare
  v_loc public.provider_locations%rowtype;
  v_prov public.providers%rowtype;
  v_lat double precision;
  v_lng double precision;
begin
  if coalesce(new.is_custom_location, false) then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.location_id is not distinct from old.location_id then
    return new;   -- only when the venue itself changes, so a deliberate address edit is not overwritten
  end if;

  if new.location_id is not null then
    select * into v_loc from public.provider_locations where id = new.location_id;
    if not found or v_loc.address is null then
      return new;   -- nothing to copy; keep what the class has
    end if;
    new.address     := v_loc.address;
    new.postal_code := v_loc.postal_code;
    new.latitude    := v_loc.latitude;
    new.longitude   := v_loc.longitude;
  elsif tg_op = 'UPDATE' and old.location_id is not null
        and new.address is not distinct from old.address then
    -- Taken off its venue and the same write supplied no address of its own: show the business.
    select * into v_prov from public.providers where id = new.provider_id;
    if not found or v_prov.address is null then
      return new;   -- the business has no address to fall back to; keep what the class has
    end if;
    new.address     := v_prov.address;
    new.postal_code := v_prov.postal_code;
    new.latitude    := v_prov.latitude;
    new.longitude   := v_prov.longitude;
  else
    return new;
  end if;

  -- The area filter reads activities.region, which activities_region_trg derives from the postal
  -- code. That trigger only fires for columns named in the UPDATE statement, and this change
  -- happens inside a BEFORE trigger, so work the region out here too, by the same rule (00096).
  select coalesce(new.latitude, p.latitude), coalesce(new.longitude, p.longitude), p.region
    into v_lat, v_lng, v_prov.region
    from public.providers p where p.id = new.provider_id;
  new.region := coalesce(
    case
      when new.postal_code is not null then public.sg_region(new.postal_code, v_lat, v_lng)
      else public.sg_region(new.postal_code, new.latitude, new.longitude)
    end,
    v_prov.region
  );
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Reconcile classes that already disagree with their venue
--
-- Wix-linked classes are left to the Wix sync. Published classes (what parents see) are brought in
-- step in full. Unpublished directory listings are only topped up where the address text already
-- matches and just the postal code / pin is missing or behind, so a wording a listing was given on
-- purpose is not rewritten. Every column named in SET makes activities_region_trg re-derive the area.
-- ---------------------------------------------------------------------------
update public.activities a
   set address     = l.address,
       postal_code = l.postal_code,
       latitude    = l.latitude,
       longitude   = l.longitude
  from public.provider_locations l
 where l.id = a.location_id
   and l.provider_id = a.provider_id
   and coalesce(a.is_custom_location, false) = false
   and a.wix_service_id is null
   and l.address is not null
   and (a.is_published or a.address is not distinct from l.address)
   and (a.address     is distinct from l.address
     or a.postal_code is distinct from l.postal_code
     or a.latitude    is distinct from l.latitude
     or a.longitude   is distinct from l.longitude);

commit;
