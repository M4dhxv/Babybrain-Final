-- 00030: Category taxonomy alignment.
-- Align the activity_categories list with the product taxonomy used on the
-- homepage "Explore by type" tiles, the signup interests and the Explore
-- "Type of activity" filter. Rename two labels, add five categories, and split
-- clearly-identifiable Swimming / Gymnastics / Holiday Camps out of the old
-- catch-all "Movement" bucket (title-only, conservative — ambiguous classes
-- such as dance, karate and team sports stay in "Movement & Dance").
--
-- Idempotent so it is safe to re-run. Slugs are stable; only names/sort_order
-- change on the existing rows, so activities.category_id references are intact.

begin;

-- Rename existing labels + set display order.
update public.activity_categories set name = 'Music',              sort_order = 1  where slug = 'music';
update public.activity_categories set name = 'Sensory Play',       sort_order = 2  where slug = 'sensory-play';
update public.activity_categories set name = 'Art & Creativity',   sort_order = 3  where slug = 'art-creativity';
update public.activity_categories set name = 'Early Learning',     sort_order = 6  where slug = 'early-learning';
update public.activity_categories set name = 'Baby & Me Exercise', sort_order = 7  where slug = 'parent-baby';
update public.activity_categories set name = 'Movement & Dance',   sort_order = 11 where slug = 'movement';

-- Add the new categories.
insert into public.activity_categories (slug, name, sort_order) values
  ('swimming',        'Swimming',         4),
  ('gymnastics',      'Gymnastics',       5),
  ('playspaces',      'Playspaces',       8),
  ('community-events','Community Events', 9),
  ('holiday-camps',   'Holiday Camps',    10)
on conflict (slug) do update set name = excluded.name, sort_order = excluded.sort_order;

-- Reclassify out of Movement & Dance (title-only, high confidence).
update public.activities set category_id = (select id from public.activity_categories where slug = 'holiday-camps')
where category_id = (select id from public.activity_categories where slug = 'movement')
  and title ~* 'holiday\s*camp';

update public.activities set category_id = (select id from public.activity_categories where slug = 'swimming')
where category_id = (select id from public.activity_categories where slug = 'movement')
  and title ~* '(swim|learn to swim|stroke develop|water baby)'
  and title !~* 'yoga';

update public.activities set category_id = (select id from public.activity_categories where slug = 'gymnastics')
where category_id = (select id from public.activity_categories where slug = 'movement')
  and title ~* '(\mgym\M|gymnast|tumbl|trampolin|parkour)';

commit;
