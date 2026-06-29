-- BabyBrain Phase 2 — Vendor/Provider schema
-- Reuses Phase 1: extends activities, activity_sessions, bookings, reviews
-- in place; adds only the genuinely new vendor tables.
-- Idempotent.

-- =============================================================
-- 1. PROVIDERS (business account; created/owned by an auth user)
--    Vendors are pre-listed as unclaimed; claiming flips is_claimed.
-- =============================================================
create table if not exists public.providers (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references auth.users (id) on delete set null,
  business_name text not null,
  slug text unique,
  description text not null default '',
  -- vendor business category (PPT taxonomy, distinct from interest categories)
  vendor_category text check (vendor_category in (
    'baby-toddler-classes','playspaces','camps-holiday','community-events',
    'mum-bub-exercise','other')),
  logo_url text,
  cover_image_url text,
  contact_email text,
  contact_phone text,
  whatsapp text,
  website text,
  social jsonb not null default '{}',          -- {instagram, facebook, tiktok}
  address text,
  postal_code text,
  latitude double precision,
  longitude double precision,
  uen text,                                    -- SG business registration no.
  is_claimed boolean not null default false,
  verification_status text not null default 'unverified'
    check (verification_status in ('unverified','pending','verified')),
  status text not null default 'draft'
    check (status in ('draft','pending','active','suspended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists providers_owner_idx on public.providers (owner_id);
create index if not exists providers_status_idx on public.providers (status) where status = 'active';

-- =============================================================
-- 2. PROVIDER MEMBERS (staff access — multiple staff per account)
-- =============================================================
create table if not exists public.provider_members (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references public.providers (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('owner','manager','staff')),
  status text not null default 'active'
    check (status in ('invited','active','disabled')),
  invited_email text,
  created_at timestamptz not null default now(),
  unique (provider_id, user_id)
);

create index if not exists provider_members_user_idx on public.provider_members (user_id, status);
create index if not exists provider_members_provider_idx on public.provider_members (provider_id);

-- =============================================================
-- 3. PROVIDER LOCATIONS (multi-venue businesses)
-- =============================================================
create table if not exists public.provider_locations (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references public.providers (id) on delete cascade,
  name text not null,
  address text,
  postal_code text,
  latitude double precision,
  longitude double precision,
  operating_hours jsonb not null default '{}', -- { mon: [["09:00","17:00"]], ... }
  is_primary boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists provider_locations_provider_idx on public.provider_locations (provider_id);

-- =============================================================
-- 4. EXTEND activities  (link to provider; vendor-controlled fields)
-- =============================================================
alter table public.activities
  add column if not exists provider_id uuid references public.providers (id) on delete cascade,
  add column if not exists location_id uuid references public.provider_locations (id) on delete set null,
  add column if not exists vendor_category text check (vendor_category in (
    'baby-toddler-classes','playspaces','camps-holiday','community-events',
    'mum-bub-exercise','other')),
  add column if not exists requires_medical_disclosure boolean not null default false,
  add column if not exists archived_at timestamptz,
  add column if not exists boosted_until timestamptz;  -- featured/sponsored placement

create index if not exists activities_provider_idx on public.activities (provider_id);
create index if not exists activities_boosted_idx on public.activities (boosted_until)
  where boosted_until is not null;

-- =============================================================
-- 5. EXTEND activity_sessions  (which venue a session runs at)
-- =============================================================
alter table public.activity_sessions
  add column if not exists location_id uuid references public.provider_locations (id) on delete set null,
  add column if not exists status text not null default 'scheduled'
    check (status in ('scheduled','cancelled'));

-- =============================================================
-- 6. EXTEND bookings  (provider link, full state machine, payment,
--    participant medical disclosure, waitlist ordering)
-- =============================================================
-- widen the status check to the Phase-2 state machine
alter table public.bookings drop constraint if exists bookings_status_check;
update public.bookings set status = 'completed' where status = 'attended';
alter table public.bookings
  add column if not exists provider_id uuid references public.providers (id) on delete cascade,
  add column if not exists waitlist_position int,
  add column if not exists medical_disclosure text,
  add column if not exists payment_status text not null default 'none'
    check (payment_status in ('none','paid','refunded')),
  add column if not exists amount numeric(10,2),
  add column if not exists stripe_payment_intent text,
  add column if not exists updated_at timestamptz not null default now();
alter table public.bookings
  add constraint bookings_status_check
  check (status in ('pending','confirmed','cancelled','completed','waitlisted'));
alter table public.bookings alter column status set default 'pending';

create index if not exists bookings_provider_idx on public.bookings (provider_id, created_at desc);
create index if not exists bookings_session_status_idx on public.bookings (session_id, status);

-- =============================================================
-- 7. ATTENDANCE (per booking; present/absent/late)
-- =============================================================
create table if not exists public.attendance (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings (id) on delete cascade,
  session_id uuid not null references public.activity_sessions (id) on delete cascade,
  status text not null check (status in ('present','absent','late')),
  note text,
  marked_by uuid references auth.users (id) on delete set null,
  marked_at timestamptz not null default now(),
  unique (booking_id)
);

create index if not exists attendance_session_idx on public.attendance (session_id);

-- =============================================================
-- 8. MAKE-UP TOKENS (issue on absence, redeem on a future booking)
-- =============================================================
create table if not exists public.make_up_tokens (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references public.providers (id) on delete cascade,
  user_id uuid references public.parent_profiles (id) on delete set null,
  child_id uuid references public.children (id) on delete set null,
  origin_booking_id uuid references public.bookings (id) on delete set null,
  redeemed_booking_id uuid references public.bookings (id) on delete set null,
  status text not null default 'issued'
    check (status in ('issued','redeemed','expired')),
  issued_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz
);

create index if not exists make_up_tokens_provider_idx on public.make_up_tokens (provider_id, status);
create index if not exists make_up_tokens_user_idx on public.make_up_tokens (user_id);

-- =============================================================
-- 9. SUBSCRIPTIONS (Stripe billing; one row per provider)
-- =============================================================
create table if not exists public.subscriptions (
  provider_id uuid primary key references public.providers (id) on delete cascade,
  plan text not null default 'free' check (plan in ('free','growth')),
  stripe_customer_id text,
  stripe_subscription_id text,
  status text not null default 'active'
    check (status in ('active','trialing','past_due','canceled','incomplete')),
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  commission_rate numeric(4,3) not null default 0.150,
  updated_at timestamptz not null default now()
);

-- =============================================================
-- 10. EXTEND reviews  (vendor response)
-- =============================================================
alter table public.reviews
  add column if not exists provider_response text,
  add column if not exists provider_responded_at timestamptz;

-- =============================================================
-- 11. LISTING EVENTS (profile/listing views + booking clicks →
--     powers analytics "profile views" & conversion; append-only)
-- =============================================================
create table if not exists public.listing_events (
  id bigint generated always as identity primary key,
  provider_id uuid references public.providers (id) on delete cascade,
  activity_id uuid references public.activities (id) on delete cascade,
  type text not null check (type in ('profile_view','listing_view','booking_click')),
  viewer_id uuid,
  created_at timestamptz not null default now()
);

create index if not exists listing_events_provider_idx on public.listing_events (provider_id, created_at);
create index if not exists listing_events_activity_idx on public.listing_events (activity_id, created_at);
