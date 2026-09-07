-- 00098_qa_recategorise_and_rename.sql
--
-- Two listing corrections from the QA sheet.
--
-- 1. 01/09: "Inspire Mum & Baby is just categorised as Swimming — should be
--    Swimming and Parent & Child exercise."
--
--    Categories are per-activity, not per-provider, so a provider appears
--    under every category its activities carry. Inspire's three listings are
--    Baby Swimming and Swimming Program (both correctly Swimming) and Baby
--    Massage — which sat under Community Events, which it plainly is not.
--    Filing that one under Parent & Child Exercise both fixes the wrong
--    category and puts the provider in the two places the row asks for,
--    without needing an activity to hold two categories.
--
-- 2. 09/08: "Biji babies is the provider name — there should be a different
--    name for the activity (Outdoor playgroup)."
--
--    Its single listing was titled with the business name, so Explore showed
--    "Biji Babies" as both the provider and the class. Renamed to the class it
--    actually is; the category is left alone, since the row didn't query it.
--
-- Scoped by provider name and title so neither statement can touch anything
-- else, and both are no-ops on a database where they have already run.

update public.activities a
set category_id = (select id from public.activity_categories where slug = 'parent-baby')
from public.providers p
where p.id = a.provider_id
  and p.business_name ilike '%inspire%mum%'
  and a.title = 'Baby Massage';

update public.activities a
set title = 'Outdoor Playgroup'
from public.providers p
where p.id = a.provider_id
  and p.business_name = 'Biji Babies'
  and a.title = 'Biji Babies';
