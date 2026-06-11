-- BabyBrain Phase 1 — Core schema
-- Run order: 00001_schema.sql -> 00002_rls.sql -> 00003_functions_triggers_seed.sql

-- =============================================================
-- 1. PARENT PROFILES (1:1 with auth.users, created by trigger)
-- =============================================================
create table if not exists public.parent_profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null default '',
  email text not null,
  phone text,
  postal_code text,
  -- geocoded from postal_code via OneMap SG during onboarding (nullable until then)
  latitude double precision,
  longitude double precision,
  onboarding_completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- =============================================================
-- 2. USER PREFERENCES (1:1 with parent, row created at signup)
-- =============================================================
create table if not exists public.user_preferences (
  user_id uuid primary key references public.parent_profiles (id) on delete cascade,
  preferred_days text[] not null default '{}'
    check (preferred_days <@ array['mon','tue','wed','thu','fri','sat','sun']),
  preferred_times text[] not null default '{}'
    check (preferred_times <@ array['morning','afternoon','evening']),
  budget_min numeric(10,2) check (budget_min >= 0),
  budget_max numeric(10,2) check (budget_max >= 0),
  -- activity interests as category slugs (e.g. 'music', 'sensory-play')
  interests text[] not null default '{}',
  updated_at timestamptz not null default now(),
  constraint budget_range_valid
    check (budget_min is null or budget_max is null or budget_min <= budget_max)
);

-- =============================================================
-- 3. CHILDREN (1 parent : N children)
-- =============================================================
create table if not exists public.children (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid not null references public.parent_profiles (id) on delete cascade,
  name text not null,
  date_of_birth date not null check (date_of_birth <= current_date),
  gender text not null default 'unspecified'
    check (gender in ('male','female','other','unspecified')),
  interests text[] not null default '{}',  -- category slugs
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists children_parent_id_idx on public.children (parent_id);

-- =============================================================
-- 4. ACTIVITY CATEGORIES (admin-managed, seeded)
-- =============================================================
create table if not exists public.activity_categories (
  id int generated always as identity primary key,
  slug text not null unique,
  name text not null,
  sort_order int not null default 0
);

-- =============================================================
-- 5. ACTIVITIES (admin-managed in Phase 1; provider is plain text
--    until the provider phase introduces real provider accounts)
-- =============================================================
create table if not exists public.activities (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  description text not null default '',
  category_id int not null references public.activity_categories (id),
  tags text[] not null default '{}',          -- extra interest slugs for matching
  provider_name text not null default '',
  age_min_months int not null default 0 check (age_min_months >= 0),
  age_max_months int not null default 216,
  price numeric(10,2) check (price >= 0),     -- SGD per session; null = enquire
  address text,
  postal_code text,
  latitude double precision,
  longitude double precision,
  image_urls text[] not null default '{}',    -- Supabase Storage public URLs
  is_published boolean not null default false,
  -- denormalized, maintained by trigger (rating) and nightly cron (popularity)
  rating_avg numeric(3,2) not null default 0,
  rating_count int not null default 0,
  popularity int not null default 0,
  search_tsv tsvector generated always as (
    to_tsvector('english', coalesce(title,'') || ' ' || coalesce(description,''))
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint age_range_valid check (age_min_months <= age_max_months)
);

create index if not exists activities_category_id_idx on public.activities (category_id);
create index if not exists activities_published_popularity_idx
  on public.activities (popularity desc) where is_published;
create index if not exists activities_search_idx on public.activities using gin (search_tsv);
create index if not exists activities_lat_lng_idx on public.activities (latitude, longitude);

-- =============================================================
-- 6. ACTIVITY SESSIONS (schedule + availability on detail page,
--    date filter on explore, upcoming classes on dashboard)
-- =============================================================
create table if not exists public.activity_sessions (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null references public.activities (id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  capacity int check (capacity > 0),          -- null = unlimited
  created_at timestamptz not null default now(),
  constraint session_times_valid check (starts_at < ends_at)
);

create index if not exists activity_sessions_activity_starts_idx
  on public.activity_sessions (activity_id, starts_at);
create index if not exists activity_sessions_starts_idx on public.activity_sessions (starts_at);

-- =============================================================
-- 7. FAVORITES (saved activities)
-- =============================================================
create table if not exists public.favorites (
  user_id uuid not null references public.parent_profiles (id) on delete cascade,
  activity_id uuid not null references public.activities (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, activity_id)
);

create index if not exists favorites_activity_id_idx on public.favorites (activity_id);

-- =============================================================
-- 8. REVIEWS (one review per user per activity)
-- =============================================================
create table if not exists public.reviews (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.parent_profiles (id) on delete cascade,
  activity_id uuid not null references public.activities (id) on delete cascade,
  rating int not null check (rating between 1 and 5),
  comment text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, activity_id)
);

create index if not exists reviews_activity_id_idx on public.reviews (activity_id, created_at desc);
create index if not exists reviews_user_id_idx on public.reviews (user_id);

-- =============================================================
-- 9. USER RECOMMENDATIONS (deterministic scores, per child;
--    written only by compute_recommendations_for_child())
-- =============================================================
create table if not exists public.user_recommendations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.parent_profiles (id) on delete cascade,
  child_id uuid not null references public.children (id) on delete cascade,
  activity_id uuid not null references public.activities (id) on delete cascade,
  score int not null check (score between 0 and 100),
  reasons text[] not null default '{}',       -- human-readable explanations
  computed_at timestamptz not null default now(),
  unique (child_id, activity_id)
);

create index if not exists user_recommendations_user_score_idx
  on public.user_recommendations (user_id, score desc);

-- =============================================================
-- 10. NOTIFICATIONS (in-app feed; email fan-out via DB webhook)
-- =============================================================
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.parent_profiles (id) on delete cascade,
  type text not null,                          -- 'welcome' | 'new_recommendations' | 'support_message' | ...
  title text not null,
  body text not null default '',
  data jsonb not null default '{}',            -- e.g. { "activity_id": "...", "url": "/dashboard" }
  read_at timestamptz,
  email_status text not null default 'pending'
    check (email_status in ('pending','sent','skipped','failed')),
  created_at timestamptz not null default now()
);

create index if not exists notifications_user_created_idx
  on public.notifications (user_id, created_at desc);
create index if not exists notifications_unread_idx
  on public.notifications (user_id) where read_at is null;

-- =============================================================
-- 11. STREAM USERS (GetStream mapping; written server-side only)
-- =============================================================
create table if not exists public.stream_users (
  user_id uuid primary key references public.parent_profiles (id) on delete cascade,
  stream_user_id text not null unique,         -- equals user_id as text, stored for auditability
  support_channel_id text,                     -- 'support-{user_id}'
  created_at timestamptz not null default now()
);

-- =============================================================
-- 12. BOOKINGS (schema only in Phase 1 — powers "Upcoming
--     Classes", "Activity History" and journey stats on the
--     dashboard; booking creation flow ships in a later phase)
-- =============================================================
create table if not exists public.bookings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.parent_profiles (id) on delete cascade,
  child_id uuid references public.children (id) on delete set null,
  session_id uuid not null references public.activity_sessions (id),
  status text not null default 'confirmed'
    check (status in ('confirmed','attended','cancelled')),
  created_at timestamptz not null default now()
);

create index if not exists bookings_user_id_idx on public.bookings (user_id, created_at desc);
create index if not exists bookings_session_id_idx on public.bookings (session_id);
