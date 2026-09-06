-- 00085_sentosa_region_fix.sql
--
-- QA 24/09 [sheet 24/08]: "Play & bloom location is incorrect — should be
-- Central, not Sentosa."
--
-- sg_region() (00032) short-circuits any postcode starting 098 or 099 to
-- 'sentosa'. Those two sectors are not the island: they straddle it and the
-- mainland HarbourFront / Telok Blangah waterfront it faces. Play & Bloom's
-- only venue is HarbourFront Centre, 099253, at 1.26397, 103.82024 — squarely
-- on the mainland, and it has been filed under Sentosa ever since.
--
-- The coordinate branch further down already has a perfectly good Sentosa test
-- (a bounding box the island fits and HarbourFront does not). It just never
-- ran, because the postal short-circuit returned first. So: when we have
-- coordinates, they decide whether a 098/099 address is actually on the
-- island; the postal prefix only settles it when there is nothing better. An
-- address that fails the box test falls through to the ordinary sector table,
-- where sector 9 is 'central' — which is where HarbourFront belongs.
--
-- Everything else about the function is unchanged, and the postal-only
-- behaviour for a 098/099 address with no coordinates is unchanged too.

begin;

create or replace function public.sg_region(
  p_postal text,
  p_lat double precision default null,
  p_lng double precision default null
)
returns text
language plpgsql
immutable
as $$
declare
  sector int;
  has_coords boolean := p_lat is not null and p_lng is not null;
  -- The island, generously drawn. HarbourFront Centre (1.2640) and VivoCity
  -- (1.2644) sit north of this; Sentosa Cove, Imbiah, Siloso and Tanjong all
  -- sit inside it.
  on_sentosa boolean := has_coords
    and p_lat < 1.262
    and p_lng between 103.80 and 103.87;
begin
  -- Sentosa has its own postal sectors, but 098/099 also cover the mainland
  -- waterfront opposite. Trust coordinates over the prefix whenever we have
  -- them; fall back to the prefix only when we don't.
  if p_postal ~ '^09[89]' then
    if not has_coords then
      return 'sentosa';
    end if;
    if on_sentosa then
      return 'sentosa';
    end if;
    -- Coordinates say mainland — carry on to the sector table below.
  end if;

  if p_postal ~ '^\d{6}$' then
    sector := substring(p_postal from 1 for 2)::int;
    return case
      when sector between  1 and 10 then 'central'      -- Raffles → Harbourfront
      when sector between 11 and 13 then 'west'         -- Pasir Panjang, Clementi
      when sector between 14 and 37 then 'central'      -- Queenstown → Braddell
      when sector between 38 and 52 then 'east'         -- Geylang → Pasir Ris
      when sector between 53 and 57 then 'north-east'   -- Hougang, Bishan, AMK
      when sector between 58 and 71 then 'west'         -- Upper Bt Timah → Tengah
      when sector between 72 and 73 then 'north'        -- Kranji, Woodgrove
      when sector between 75 and 78 then 'north'        -- Yishun → Springleaf
      when sector in (79, 80, 82)   then 'north-east'   -- Seletar, Punggol
      when sector = 81              then 'east'         -- Loyang, Changi
      else null
    end;
  end if;

  if has_coords then
    if on_sentosa then
      return 'sentosa';
    end if;
    return (
      select r.name
      from (values
        ('central',    1.300, 103.830),
        ('east',       1.335, 103.940),
        ('north-east', 1.385, 103.895),
        ('north',      1.430, 103.820),
        ('west',       1.335, 103.720)
      ) as r(name, lat, lng)
      order by (p_lat - r.lat) ^ 2 + (p_lng - r.lng) ^ 2
      limit 1
    );
  end if;

  return null;
end;
$$;

-- Re-derive everything the old rule mislabelled. Unlike 00032's activity
-- backfill this is not limited to null regions — the whole point is to correct
-- rows that already hold a (wrong) value.
update public.providers
set region = public.sg_region(postal_code, latitude, longitude)
where region is distinct from public.sg_region(postal_code, latitude, longitude);

update public.provider_locations
set region = public.sg_region(postal_code, latitude, longitude)
where region is distinct from public.sg_region(postal_code, latitude, longitude);

update public.activities a
set region = coalesce(
  public.sg_region(a.postal_code, a.latitude, a.longitude),
  (select p.region from public.providers p where p.id = a.provider_id)
)
where a.region is distinct from coalesce(
  public.sg_region(a.postal_code, a.latitude, a.longitude),
  (select p.region from public.providers p where p.id = a.provider_id)
);

commit;
