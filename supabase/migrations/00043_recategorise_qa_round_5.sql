-- 00043_recategorise_qa_round_5.sql
--
-- The twenty "Miscategorised" rows from the 10/08 QA round.
--
-- These are data corrections, not code: the bulk importer files a whole vendor
-- under one category, so an academic tuition class at a music school lands in
-- Music & Drama and a gym's summer camp stays under Gym & Dance. Every target
-- below was matched against the live rows first, so each `where` clause names
-- a title/provider pair that actually exists rather than a guess.
--
-- Matching is on (provider_name, title) and is case-insensitive, because the
-- importer's capitalisation is inconsistent. Titles are matched with `ilike`
-- on a distinctive fragment so a later re-import with slightly different
-- punctuation (e.g. "Messy-Play" vs "Messy Play") still hits.

create temporary table recat (provider text, title text, slug text) on commit drop;

insert into recat (provider, title, slug) values
  -- 1. Multi-sports and after-school sport → Gym & Dance (filed under Music)
  ('prodigy sports%', 'Prodigy Multi-Sports Program',                     'movement'),
  ('prodigy sports%', '%Marina Sentosa Cove Multi-Sports Program',        'movement'),
  ('prodigy sports%', 'Prodigy After School Club',                        'movement'),

  -- 2. Impressions Kids Club creative programmes → Sensory & Art
  ('impressions kids club', 'Creative programmes',                        'sensory-play'),

  -- 3. The Yard's summer camps → Holiday Camps (a camp is a camp)
  ('the yard gymnastics', 'Summer Camps',                                 'holiday-camps'),

  -- 4. Play & Bloom academic tuition → Early Learning. The music-theatre and
  --    ballet classes at the same vendor are left where they are.
  ('play & bloom%', 'Prep for PSLE%',                                     'early-learning'),
  ('play & bloom%', '%Mandarin',                                          'early-learning'),
  ('play & bloom%', '%English',                                           'early-learning'),
  ('play & bloom%', '%Math%',                                             'early-learning'),

  -- 5/18. Baby massage is a meet-up rather than a class → Community Events
  ('mother & child yoga', 'Baby Massage',                                 'community-events'),
  ('inspire mum & baby',  'Baby Massage',                                 'community-events'),

  -- 6. Mucky Pups → Sensory & Art
  ('mother & child yoga', 'Mucky Pups',                                   'sensory-play'),

  -- 7. Lucy Sparkles → Music & Drama
  ('mother & child yoga', 'Lucy Sparkles',                                'music'),

  -- 8. Montessori for Babies → Early Learning
  ('mother & child yoga', 'Montessori for Babies',                        'early-learning'),

  -- 9. SMART-START English preschool-ready → Early Learning
  ('the music scientist', 'SMART-START English Preschool Ready%',         'early-learning'),

  -- 10. Wildlings: forest sessions → Sensory & Art, camps → Holiday Camps
  ('wildlings%', 'Nature Playtime sessions',                              'sensory-play'),
  ('wildlings%', 'Playgroups',                                            'sensory-play'),
  ('wildlings%', 'Forest School club',                                    'sensory-play'),
  ('wildlings%', 'Adventure Camps',                                       'holiday-camps'),

  -- 12. SRT Theatre Classes → Music & Drama (filed under the venue's default)
  ('kidsspace', 'SRT Theatre Classes',                                    'music'),

  -- 13. My Gym trial → Gym & Dance
  ('my gym', 'Single Trial Experience',                                   'movement'),

  -- 14. Biji Babies → Sensory & Art (see the rename note at the end)
  ('biji babies', 'Biji Babies',                                          'sensory-play'),

  -- 15. Aerial Yoga Playdate → Parent & Child Exercise
  ('avoyogasg%', 'Aerial Yoga Playdate',                                  'parent-baby'),

  -- 17. Kaboodle storytelling/messy play → Sensory & Art
  ('kaboodle', 'Thematic Storytelling and Messy%',                        'sensory-play'),

  -- 19. Kidsspace creative classes → Sensory & Art
  ('kidsspace', 'Creative Classes',                                       'sensory-play'),

  -- 20. Ms Nat kindergarten → Early Learning
  ('ms nat learning', 'Kindergarten',                                     'early-learning');

update public.activities a
   set category_id = c.id,
       updated_at  = now()
  from recat r
  join public.activity_categories c on c.slug = r.slug
 where a.provider_name ilike r.provider
   and a.title ilike r.title
   and a.category_id is distinct from c.id;

-- =============================================================
-- Adult-only listings: withdraw rather than delete
-- =============================================================
-- QA: these "don't involve children", so they don't belong in a directory of
-- children's activities. Unpublishing keeps the row (and any bookings that
-- reference it) intact and is reversible, unlike a delete.
update public.activities
   set is_published = false,
       archived_at  = coalesce(archived_at, now()),
       updated_at   = now()
 where (provider_name ilike 'mother & child yoga' and title ilike 'Introduction to Solids')
    or (provider_name ilike 'mother & child yoga' and title ilike 'Mindful Mums')
    or (provider_name ilike 'active women'        and title ilike 'TheMotherhoodSpace');

-- =============================================================
-- Not done here: the Biji Babies rename
-- =============================================================
-- QA also asked for a distinct activity name, because "Biji Babies" is the
-- provider and is being reused as the class title. Left alone deliberately —
-- inventing a public-facing class name is the founder's call, not a migration's.
-- Category is corrected above; rename once a name is agreed.

notify pgrst, 'reload schema';
