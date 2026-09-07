-- 00098_rename_gym_dance_category.sql
--
-- QA 21/08: "Can we change the name of the category 'Gym & Dance' to
-- 'Gym, Dance & Other Sports' on home page, explore page and sign up page."
--
-- Explore and the category chips read activity_categories.name straight from
-- here, so the label is one row. The home and sign-up tiles carry their own
-- copy in frontends/parent/src/data/content.ts and are renamed alongside this.
--
-- The slug stays 'movement'. It is what every activity's category_id resolves
-- through, what the ?cat= filter puts in the URL, and what 00031/00043/00050
-- reference by name — renaming it would break saved links and re-file nothing.
-- 00031 already set this label once (merging Gymnastics into Movement & Dance);
-- this is the same kind of edit.

update public.activity_categories
set name = 'Gym, Dance & Other Sports'
where slug = 'movement';
