-- 00037_recategorise_and_age_caps.sql
--
-- Cleans up after the bulk import in 00036's wake, and closes the
-- categorisation items from the 21/07 and 06/08 QA rounds.
--
-- The importer assigned ONE category per vendor and stamped it on every class
-- it created, so a playspace that also runs a music session had all its open
-- play slots filed under Music & Drama. That is the "GoBub is a playspace"
-- complaint, reintroduced. Categories are now decided per class: the vendor
-- sets the default, and the class title overrides it when it clearly says
-- otherwise (a camp is a camp wherever it runs).

-- =============================================================
-- 1. Vendor-level default category
-- =============================================================
create temporary table vendor_cat (pattern text, slug text) on commit drop;
insert into vendor_cat (pattern, slug) values
  -- Playspaces: open-play venues. QA: "unless it is a class hosted there,
  -- it should be under playspace".
  ('vroomtown','playspaces'), ('wan to play','playspaces'), ('amazonia','playspaces'),
  ('pirateland','playspaces'), ('little bear','playspaces'), ('little play social','playspaces'),
  ('joys of toys','playspaces'), ('kidztropic','playspaces'), ('kidztopia','playspaces'),
  ('happy wiz','playspaces'), ('gobub','playspaces'), ('buds by shangri','playspaces'),
  ('kidsspace','playspaces'), ('better play','playspaces'), ('joy play','playspaces'),
  ('kaboodle','playspaces'),
  -- Gyms
  ('the yard','movement'), ('my gym','movement'), ('little gym','movement'),
  ('power kids gym','movement'),
  -- Swimming
  ('swish','swimming'), ('aquaducks','swimming'), ('penguin swim','swimming'),
  ('swim sentosa','swimming'),
  -- Community events
  ('hey mums','community-events'), ('dad life','community-events'),
  -- Early learning
  ('sparkanaught','early-learning'), ('practical montessori','early-learning'),
  ('ms nat learning','early-learning'), ('montebabes','early-learning'),
  ('brainfit','early-learning'),
  -- Sensory & art
  ('curiosium','sensory-play'), ('muse arts','sensory-play'), ('the artground','sensory-play'),
  -- Parent & child exercise. QA listed these explicitly; adult-only classes
  -- from the same vendors are already unpublished by the import guard.
  ('freddom yoga','parent-baby'), ('moveit pilates','parent-baby'), ('hom yoga','parent-baby'),
  ('kindle space','parent-baby'), ('avoyoga','parent-baby'), ('spirit stretch','parent-baby'),
  ('mother & child','parent-baby'), ('active women','parent-baby'),
  ('inspire mum','parent-baby'), ('we barre','parent-baby'),
  ('physio down under','parent-baby'), ('grounded spaces','parent-baby'),
  ('train with be','parent-baby'),
  -- Music
  ('kindermusik','music'), ('lucy sparkles','music'), ('musical monkeys','music'),
  ('the music scientist','music'), ('our music studio','music'), ('boogie bug','music'),
  ('tippytoes','music'), ('music and movement','music'), ('joy connections','music');

update public.activities a
   set category_id = c.id
  from vendor_cat v
  join public.activity_categories c on c.slug = v.slug
 where a.is_published
   and lower(coalesce(
         (select p.business_name from public.providers p where p.id = a.provider_id),
         a.provider_name)) like '%' || v.pattern || '%';

-- =============================================================
-- 2. Class title overrides the vendor default
-- =============================================================
-- A holiday camp is a holiday camp wherever it runs, and a playspace that
-- genuinely hosts a music class should file that one class under music.
update public.activities a
   set category_id = c.id
  from public.activity_categories c
 where a.is_published
   and c.slug = case
     when a.title ~* 'holiday camp|camp\M|school holiday'          then 'holiday-camps'
     when a.title ~* 'swim|water babies|aqua'                       then 'swimming'
     when a.title ~* 'music|sing|melod|rhythm|drama|storytell'      then 'music'
     when a.title ~* 'art|craft|messy play|sensory|paint|clay'      then 'sensory-play'
     when a.title ~* 'gym|dance|ballet|tumbl|movement|yoga for kids' then 'movement'
     when a.title ~* 'meet-?up|community|social|playdate|coffee'    then 'community-events'
     when a.title ~* 'open play|drop-?in|free play|play session'    then 'playspaces'
     else null end;

-- =============================================================
-- 3. Playspace slots all read "Open Play"
-- =============================================================
-- QA: "All play space timeslots should be called 'Open Play' with venue name
-- underneath." The venue already renders beneath the title on the card.
update public.activities a
   set title = 'Open Play'
  from public.activity_categories c
 where c.id = a.category_id
   and c.slug = 'playspaces'
   and a.is_published
   and a.title !~* 'open play'
   -- Leave genuinely-named classes alone; only rename the generic slots.
   and a.title !~* 'bake|craft|class|workshop|camp|party';

-- =============================================================
-- 4. Cap ages at 11 years
-- =============================================================
-- QA: "Some classes under Prodigy sports are for 2-16 years. There needs to be
-- a cap of 11 years of age." 216 months (18y) was the importer's default when a
-- page stated no upper age, which put 62 listings past the cap.
update public.activities
   set age_max_months = 132
 where age_max_months > 132;

update public.activities
   set age_min_months = 0
 where age_min_months < 0;

-- =============================================================
-- 5. Backfill missing regions
-- =============================================================
-- Region drives the Area filter and the "Central/East/..." line on cards, so a
-- null means the listing is invisible to that filter.
update public.activities a
   set region = coalesce(
         public.sg_region(a.postal_code, a.latitude, a.longitude),
         (select public.sg_region(p.postal_code, p.latitude, p.longitude)
            from public.providers p where p.id = a.provider_id))
 where a.region is null;

update public.providers p
   set region = public.sg_region(p.postal_code, p.latitude, p.longitude)
 where p.region is null;

notify pgrst, 'reload schema';
