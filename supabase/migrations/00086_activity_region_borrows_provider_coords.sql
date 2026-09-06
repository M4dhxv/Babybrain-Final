-- 00086_activity_region_borrows_provider_coords.sql
--
-- Follow-on from 00085. Correcting sg_region() moved Play & Bloom's venue and
-- provider row to 'central', but its twelve activities stayed on 'sentosa'.
--
-- Each of those activities carries its own postal_code (099253) and no
-- coordinates. set_activity_region() resolves the activity's own address
-- first, so sg_region('099253', null, null) had nothing to disambiguate with
-- and fell back to the postal prefix — the exact ambiguity 00085 fixed — and
-- the coalesce to the provider's (now correct) region never ran, because the
-- activity's own answer was not null, just wrong.
--
-- An activity with no coordinates of its own sits at its provider's address in
-- every other respect: search_activities already displays and measures
-- distance from coalesce(a.latitude, p.latitude). Region derivation now
-- borrows them the same way — but ONLY to disambiguate a postcode it already
-- has. An activity with no postcode still resolves exactly as before (its own
-- coordinates, then its provider's region), because for those the provider's
-- coordinates would reach the nearest-centroid fallback, and a coarse centroid
-- guess is worse than the precise postal sector the provider's region came
-- from. Borrowing them unconditionally moved 25 activities, most of them
-- wrongly; this moves only the ones the 098/099 ambiguity mislabelled.

begin;

create or replace function public.set_activity_region()
returns trigger language plpgsql as $$
declare
  v_lat double precision;
  v_lng double precision;
  v_provider_region text;
begin
  select coalesce(new.latitude, p.latitude), coalesce(new.longitude, p.longitude), p.region
    into v_lat, v_lng, v_provider_region
  from public.providers p
  where p.id = new.provider_id;

  new.region := coalesce(
    case
      when new.postal_code is not null
        then public.sg_region(new.postal_code, v_lat, v_lng)
      else public.sg_region(new.postal_code, new.latitude, new.longitude)
    end,
    v_provider_region
  );
  return new;
end;
$$;

-- Re-derive every activity under the corrected rule.
update public.activities a
set region = coalesce(
  case
    when a.postal_code is not null
      then public.sg_region(a.postal_code, coalesce(a.latitude, p.latitude), coalesce(a.longitude, p.longitude))
    else public.sg_region(a.postal_code, a.latitude, a.longitude)
  end,
  p.region
)
from public.providers p
where p.id = a.provider_id
  and a.region is distinct from coalesce(
    case
      when a.postal_code is not null
        then public.sg_region(a.postal_code, coalesce(a.latitude, p.latitude), coalesce(a.longitude, p.longitude))
      else public.sg_region(a.postal_code, a.latitude, a.longitude)
    end,
    p.region
  );

commit;
