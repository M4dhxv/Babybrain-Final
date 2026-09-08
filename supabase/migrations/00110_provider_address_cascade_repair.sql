-- 00110_provider_address_cascade_repair.sql
--
-- QA re-report of 00093 ("Updated address on settings and it didn't reflect").
--
-- 00093 added cascade_provider_address(): when a provider's address changes,
-- carry it onto the activities that were holding a copy of the OLD address
-- string, leaving a genuinely different per-activity address alone. That
-- works for every edit made since it shipped (verified: changing a
-- provider's address moves its same-address activities and leaves the
-- other-venue ones put).
--
-- Two gaps remain, both fixed here:
--
-- 1. Exact-string match is too narrow. An activity at the SAME building as
--    the provider — same full 6-digit postal code — but with slightly
--    different address wording (import variance, or an edit made before
--    00093 existed) never matched, so a later provider address change
--    skipped it. BabyBrain Demo Provider is the live example: the provider
--    moved "123 Demo Street" -> "123 Demo Road" on 04/09, three days before
--    00093's trigger existed, so its four 049320 activities are still stuck
--    on "…Street" and no future edit would catch them. A different postal
--    code is still treated as a deliberate other-venue override and left
--    untouched.
--
-- 2. The early-return only looked at address, so a provider correcting just
--    its postal code or coordinates — same street line — cascaded nothing,
--    and the activities kept the wrong pin / region on the parent side.
--
-- Then a one-time backfill for rows that already drifted (gap 1 above):
-- 4 activities, all BabyBrain Demo Provider. The activities_region_trg
-- (BEFORE UPDATE OF postal_code, latitude, longitude) re-derives region on
-- the way through.

begin;

create or replace function public.cascade_provider_address()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  -- Nothing to do only when every locational field is unchanged.
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
    and (
      -- Was carrying a copy of the address string being replaced.
      a.address is not distinct from old.address
      -- …or sits at the provider's own building (same full postal code) but
      -- has drifted in wording. Same 6-digit code = same address in SG, so
      -- this is a stale copy, not an override. An activity that genuinely
      -- runs elsewhere carries a different postal code and is left alone.
      or (
        old.postal_code is not null
        and a.postal_code is not distinct from old.postal_code
        and a.address is not null
      )
    );

  return new;
end;
$$;

comment on function public.cascade_provider_address() is
  'Carries a provider address change onto the activities that were holding a '
  'copy of the old one, or that sit at the provider''s own building (same '
  'postal code) with drifted wording. A genuinely different per-activity '
  'address (different postal code) is left alone.';

-- ---------------------------------------------------------------------------
-- One-time backfill: activities at their provider's building whose address
-- text no longer matches. Coordinates and postal code ride along; region
-- re-derives via activities_region_trg.
-- ---------------------------------------------------------------------------
update public.activities a
set address     = p.address,
    postal_code = p.postal_code,
    latitude    = p.latitude,
    longitude   = p.longitude
from public.providers p
where p.id = a.provider_id
  and a.postal_code is not null
  and p.postal_code is not null
  and a.postal_code = p.postal_code
  and a.address is distinct from p.address
  and a.address is not null;

commit;
