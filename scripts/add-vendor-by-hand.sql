-- Add one vendor and its classes by hand, from the Supabase SQL editor.
--
-- Paste, edit the two VALUES blocks at the top, run. Everything else resolves
-- itself: the provider id is passed down to the locations and activities, and
-- the category is looked up by slug so you never touch a numeric id.
--
-- Safe to re-run: `on conflict (slug) do update` means fixing a typo and
-- running again updates the row instead of creating a duplicate.
--
-- Category slugs (must be one of these):
--   music · sensory-play · movement · swimming · early-learning
--   parent-baby · playspaces · community-events · holiday-camps
--
-- Vendor categories:
--   baby-toddler-classes · playspaces · camps-holiday
--   community-events · mum-bub-exercise · other

begin;

with
-- 1 ── the business ────────────────────────────────────────────────────────
vendor as (
  select
    'Physio Down Under'::text            as business_name,
    'physio-down-under'::text            as slug,          -- lowercase, hyphens
    'Mum-and-baby movement classes.'::text as description,
    'mum-bub-exercise'::text             as vendor_category,
    'hello@example.com'::text            as contact_email, -- or null
    '+65 8123 4567'::text                as contact_phone, -- or null
    null::text                           as whatsapp,
    'https://example.com'::text          as website,
    '1 Example Road, Singapore 049145'::text as address,
    '049145'::text                       as postal_code,   -- drives the region
    'https://example.com/book'::text     as booking_url    -- null = book on BabyBrain
),

-- 2 ── the classes ─────────────────────────────────────────────────────────
--     One row per class. age_min/age_max are in MONTHS (2 years = 24).
--     price in SGD, or null for "price on enquiry".
classes(title, category_slug, age_min, age_max, price, blurb) as (
  values
    ('Mum & Baby Movement', 'parent-baby',  2,  18, 45.00, 'Gentle post-natal movement with your baby.'),
    ('Toddler Tumble',      'movement',    18,  36, 40.00, 'Guided play for confident little movers.')
),

-- 3 ── insert ──────────────────────────────────────────────────────────────
ins_provider as (
  insert into public.providers (
    business_name, slug, description, vendor_category,
    contact_email, contact_phone, whatsapp, website,
    address, postal_code, source_url,
    is_claimed, is_auto_listed, verification_status, status, synced_at
  )
  select
    business_name, slug, description, vendor_category,
    contact_email, contact_phone, whatsapp, website,
    address, postal_code, website,
    false, false, 'unverified', 'active', now()
  from vendor
  on conflict (slug) do update set
    business_name  = excluded.business_name,
    description    = excluded.description,
    contact_email  = excluded.contact_email,
    contact_phone  = excluded.contact_phone,
    website        = excluded.website,
    address        = excluded.address,
    postal_code    = excluded.postal_code,
    updated_at     = now()
  returning id, business_name, address, postal_code
),

ins_location as (
  insert into public.provider_locations (provider_id, name, address, postal_code, is_primary)
  select p.id, p.business_name, p.address, p.postal_code, true
  from ins_provider p
  where p.address is not null
  returning id
),

ins_activities as (
  insert into public.activities (
    slug, title, description, category_id, provider_id, provider_name,
    vendor_category, age_min_months, age_max_months, price,
    address, postal_code, external_booking_url, is_published
  )
  select
    -- slug must be unique across all activities, so it is prefixed by vendor
    v.slug || '-' || regexp_replace(lower(c.title), '[^a-z0-9]+', '-', 'g'),
    c.title,
    c.blurb,
    cat.id,
    p.id,
    p.business_name,
    v.vendor_category,
    c.age_min,
    c.age_max,
    c.price,
    p.address,
    p.postal_code,
    v.booking_url,
    true
  from classes c
  cross join vendor v
  cross join ins_provider p
  join public.activity_categories cat on cat.slug = c.category_slug
  on conflict (slug) do update set
    title          = excluded.title,
    description    = excluded.description,
    category_id    = excluded.category_id,
    age_min_months = excluded.age_min_months,
    age_max_months = excluded.age_max_months,
    price          = excluded.price,
    is_published   = true
  returning id, title
)

select
  (select business_name from ins_provider)          as provider,
  (select count(*) from ins_location)               as locations_added,
  (select count(*) from ins_activities)             as classes_added,
  (select string_agg(title, ', ') from ins_activities) as class_titles;

-- Check the output above, then:
commit;
-- ...or `rollback;` instead if it doesn't look right.
