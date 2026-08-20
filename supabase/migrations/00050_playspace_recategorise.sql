-- QA 18/08/26: "Sensory play is pulling playspaces in too … Amazonia's
-- Multi-Level Play Gym is still playspace, Little Bear's House Single Playdate
-- is still playspace."
--
-- Both are drop-in play at a playspace, not a taught class, so they belong
-- under Playspaces. Neither was actually filed under Sensory & Art — the Play
-- Gym sat under Gym & Dance and the Playdate under Music & Drama, which is why
-- an earlier pass over the sensory category never caught them.
--
-- Matched on title + provider rather than by id so this reads as what it does,
-- and re-running it is harmless.

begin;

update public.activities a
set category_id = (select id from public.activity_categories where slug = 'playspaces')
from public.providers p
where a.provider_id = p.id
  and (
    (p.business_name ilike '%amazonia%'      and a.title ilike '%multi-level play gym%')
    or (p.business_name ilike '%little bear%' and a.title ilike '%single playdate%')
  );

commit;
