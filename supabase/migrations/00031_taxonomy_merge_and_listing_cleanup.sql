-- 00031: Founder QA round (15/07 – 06/08) — taxonomy merge + listing cleanup.
--
-- Taxonomy changes requested:
--   * merge "Gymnastics" into "Movement & Dance", rename to "Gym & Dance"
--   * rename "Music" to "Music & Drama"
--   * merge "Art & Creativity" into "Sensory Play", rename to "Sensory & Art"
-- Slugs are deliberately left unchanged (music / movement / sensory-play) —
-- they are stored in children.interests and user_preferences.interests and are
-- linked from /explore?cat=…, so renaming them would orphan existing data.
--
-- Listing changes requested: recategorise play spaces, baby & me exercise,
-- community events, swimming and early learning; drop mock/closed listings;
-- give play-space slots a consistent "Open Play" title; cap ages at 11 years.
--
-- Idempotent: safe to re-run.

begin;

-- =============================================================
-- 1. Category merge
-- =============================================================
-- Move activities off the two categories being retired.
update public.activities
set category_id = (select id from public.activity_categories where slug = 'sensory-play')
where category_id = (select id from public.activity_categories where slug = 'art-creativity');

update public.activities
set category_id = (select id from public.activity_categories where slug = 'movement')
where category_id = (select id from public.activity_categories where slug = 'gymnastics');

-- Rewrite stored interest slugs on child + preference records to match.
update public.children
set interests = (
  select coalesce(array_agg(distinct case i
                              when 'art-creativity' then 'sensory-play'
                              when 'gymnastics'     then 'movement'
                              else i end), '{}')
  from unnest(interests) as t(i)
)
where interests && array['art-creativity', 'gymnastics'];

update public.user_preferences
set interests = (
  select coalesce(array_agg(distinct case i
                              when 'art-creativity' then 'sensory-play'
                              when 'gymnastics'     then 'movement'
                              else i end), '{}')
  from unnest(interests) as t(i)
)
where interests && array['art-creativity', 'gymnastics'];

delete from public.activity_categories where slug in ('art-creativity', 'gymnastics');

-- Rename + reorder what's left (9 categories).
update public.activity_categories set name = 'Music & Drama',      sort_order = 1 where slug = 'music';
update public.activity_categories set name = 'Sensory & Art',      sort_order = 2 where slug = 'sensory-play';
update public.activity_categories set name = 'Gym & Dance',        sort_order = 3 where slug = 'movement';
update public.activity_categories set name = 'Swimming',           sort_order = 4 where slug = 'swimming';
update public.activity_categories set name = 'Early Learning',     sort_order = 5 where slug = 'early-learning';
update public.activity_categories set name = 'Baby & Me Exercise', sort_order = 6 where slug = 'parent-baby';
update public.activity_categories set name = 'Playspaces',         sort_order = 7 where slug = 'playspaces';
update public.activity_categories set name = 'Community Events',   sort_order = 8 where slug = 'community-events';
update public.activity_categories set name = 'Holiday Camps',      sort_order = 9 where slug = 'holiday-camps';

-- =============================================================
-- 2. Retire listings that shouldn't be on the platform
-- =============================================================
-- Unpublish rather than delete: several of these have bookings attached and
-- deleting would break those records. Archived rows are invisible to parents.
--
-- 2a. Mock/seed listings never on the supplier list (Tiny Tunes, MelodyHaus,
--     Little Senses SG, Curious Cubs, AquaSprouts, Om Littles, JumpStart Kids,
--     Studio Mini). All of these carry no linked provider record.
update public.activities
set is_published = false, archived_at = coalesce(archived_at, now())
where provider_id is null;

-- MelodyHaus Studio is a seed provider with a provider row.
update public.activities a
set is_published = false, archived_at = coalesce(archived_at, now())
from public.providers p
where p.id = a.provider_id and p.business_name in ('MelodyHaus Studio', 'Tiny Tunes Studio');

-- 2b. Kinder Klasse has permanently closed.
update public.activities a
set is_published = false, archived_at = coalesce(archived_at, now())
from public.providers p
where p.id = a.provider_id and p.business_name = 'Kindler Klasse';

update public.providers set status = 'suspended'
where business_name = 'Kindler Klasse' and status is distinct from 'suspended';

-- 2c. We don't do birthday parties.
update public.activities a
set is_published = false, archived_at = coalesce(archived_at, now())
from public.providers p
where p.id = a.provider_id and p.business_name = 'The Artground' and a.title ilike 'Birthday%';

-- 2d. GoBub is a play space — its class listings aren't advertised on their
--     own site, so showing them here is misleading.
update public.activities a
set is_published = false, archived_at = coalesce(archived_at, now())
from public.providers p
where p.id = a.provider_id and p.business_name = 'GoBub' and a.title = 'Music Class';

-- 2e. Baby & Me Exercise vendors: keep only genuine parent+baby classes.
--     Pre/post-natal-only and general adult fitness classes come off.
update public.activities a
set is_published = false, archived_at = coalesce(archived_at, now())
from public.providers p
where p.id = a.provider_id
  and p.business_name in (
    'Freddom yoga', 'Moveit Pilates', 'Hom Yoga', 'Kindle space',
    'Avoyogasg - aerial yoga', 'Spirit Stretch', 'Mother & Child Yoga',
    'Active Women', 'Inspire Mum & Baby', 'We Barre', 'Physio Down Under',
    'Grounded Spaces', 'Train with Be'
  )
  and (
    a.title ~* '(prenatal|pre-natal|antenatal|postnatal|post-natal|postpartum|natal)'
    or a.title in (
      'Hot Yoga', 'Vinyasa Flow', 'Reformer Pilates', 'Pilates', 'Barre',
      'Pelvic Floor Rehab', 'Personal Training', 'WeBarre Class',
      'Be. Classes', 'Aerial Yoga', 'Avoyoga'
    )
  );

-- =============================================================
-- 3. Recategorisation
-- =============================================================
create or replace function pg_temp.recat(p_provider text, p_slug text, p_titles text[] default null)
returns void language sql as $$
  update public.activities a
  set category_id = (select id from public.activity_categories where slug = p_slug)
  from public.providers p
  where p.id = a.provider_id
    and p.business_name = p_provider
    and (p_titles is null or a.title = any(p_titles));
$$;

-- 3a. Play spaces (open play is its own category; classes hosted at a play
--     space keep their class category).
select pg_temp.recat(v, 'playspaces') from unnest(array[
  'Wan to play', 'Amazonia Great world', 'Pirateland', 'Little Bear''s House',
  'Little Play Social', 'Joys of toys', 'Kidztropic', 'Kidztopia',
  'Happy wiz', 'Vroomtown', 'GoBub'
]) as t(v);
select pg_temp.recat('Better Play', 'playspaces', array['Open Play']);
select pg_temp.recat('Impressions Kids Club', 'playspaces', array['Open Play']);
select pg_temp.recat('Shangri La soft play etc', 'playspaces', array['Buds by Shangri-La']);

-- 3b. Baby & Me Exercise.
select pg_temp.recat(v, 'parent-baby') from unnest(array[
  'Freddom yoga', 'Moveit Pilates', 'Hom Yoga', 'Kindle space',
  'Avoyogasg - aerial yoga', 'Spirit Stretch', 'Mother & Child Yoga',
  'Active Women', 'Inspire Mum & Baby', 'We Barre', 'Physio Down Under',
  'Grounded Spaces', 'Train with Be'
]) as t(v);
-- …except Inspire Mum & Baby's swim class, which is swimming.
select pg_temp.recat('Inspire Mum & Baby', 'swimming', array['Baby Swimming']);

-- 3c. Community events.
select pg_temp.recat(v, 'community-events') from unnest(array[
  'Hey Mums', 'Dad Life Club'
]) as t(v);

-- 3d. Gym & Dance.
select pg_temp.recat(v, 'movement') from unnest(array[
  'The yard gymnastics', 'My gym', 'Little gym Singapore', 'Power kids gym'
]) as t(v);

-- 3e. Swimming — Swish's parent/baby and private lessons are swim lessons.
select pg_temp.recat('Swish', 'swimming', array['Parent & Baby Classes', 'Private Lessons']);

-- 3f. Early learning.
select pg_temp.recat('Sparkanaughts', 'early-learning');

-- 3g. Centre Stage: drama/theatre/acting is Music & Drama, dance is Gym & Dance.
select pg_temp.recat('Centre Stage', 'music',
  array['Creative Drama', 'Musical Theatre', 'Trinity Acting for Screen', 'Saturday Summer Classes']);
select pg_temp.recat('Centre Stage', 'movement', array['Dance']);

-- 3h. Lucy Sparkles' dance/drama classes.
select pg_temp.recat('Lucy Sparkles', 'movement', array['Dance Classes']);

-- =============================================================
-- 4. Naming
-- =============================================================
-- 4a. "Shangri La soft play etc" was a working name in the supplier sheet.
update public.providers
set business_name = 'Buds by Shangri-La'
where business_name = 'Shangri La soft play etc';

-- 4b. Every play-space slot is titled "Open Play"; the venue shows underneath.
update public.activities a
set title = 'Open Play'
from public.providers p
where p.id = a.provider_id
  and a.category_id = (select id from public.activity_categories where slug = 'playspaces')
  and a.is_published
  and (a.title = p.business_name or a.title ilike 'Buds by Shangri-La');

-- 4c. Listings whose title duplicates the provider name lose the purple
--     provider line on the card. Give them a real activity name so the card
--     reads "<activity>" with "<provider>" underneath.
update public.activities a set title = 'Music Playgroup'
from public.providers p where p.id = a.provider_id and p.business_name = 'Tippytoes Music Playgroup' and a.title = p.business_name;

update public.activities a set title = 'Baby Development Classes'
from public.providers p where p.id = a.provider_id and p.business_name = 'BrainFit Baby' and a.title = p.business_name;

update public.activities a set title = 'Speech & Language Sessions'
from public.providers p where p.id = a.provider_id and p.business_name = 'Wonder Words' and a.title = p.business_name;

update public.activities a set title = 'Parent & Baby Meet-up'
from public.providers p where p.id = a.provider_id and p.business_name = 'Tiny Tots & Toddler Time' and a.title = p.business_name;

update public.activities a set title = 'Mums Community Meet-up'
from public.providers p where p.id = a.provider_id and p.business_name = 'Hey Mums' and a.title = p.business_name;

update public.activities a set title = 'Dads Community Meet-up'
from public.providers p where p.id = a.provider_id and p.business_name = 'Dad Life Club' and a.title = p.business_name;

-- Anything else still mirroring its provider name gets a category-derived name.
update public.activities a
set title = case c.slug
  when 'music'            then 'Music Classes'
  when 'sensory-play'     then 'Sensory & Art Classes'
  when 'movement'         then 'Gym & Dance Classes'
  when 'swimming'         then 'Swim Lessons'
  when 'early-learning'   then 'Early Learning Classes'
  when 'parent-baby'      then 'Baby & Me Classes'
  when 'playspaces'       then 'Open Play'
  when 'community-events' then 'Community Meet-up'
  when 'holiday-camps'    then 'Holiday Camp'
  else a.title end
from public.providers p, public.activity_categories c
where p.id = a.provider_id and c.id = a.category_id
  and a.is_published
  and lower(trim(a.title)) = lower(trim(p.business_name));

-- =============================================================
-- 5. Age cap — BabyBrain covers up to 11 years old.
-- =============================================================
-- Both bounds move in one statement so the age_range_valid check never sees a
-- half-updated row (e.g. Prodigy's 2–16y classes become 2–11y).
update public.activities
set age_max_months = least(age_max_months, 132),
    age_min_months = least(age_min_months, 132)
where age_max_months > 132 or age_min_months > 132;

commit;
