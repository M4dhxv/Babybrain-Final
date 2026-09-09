-- 00116_provider_member_profiles.sql
--
-- The Team tab (Settings) only ever had the bare `provider_members` row to
-- work with — role, status, invited_email — so a teammate rendered as a raw
-- email address with no name, title or phone anywhere.
--
-- This adds a small side table, one row per membership, for those basic
-- details. `provider_members` itself is owner-write-only under RLS
-- ("owners manage staff", 00007), so putting editable fields there would stop
-- a staff member (or a manager) maintaining their own details. A separate
-- table lets each person edit their own row, and lets an owner/manager edit
-- anyone's, without touching the membership/role model.
--
-- Frozen-by-omission: email and role are NOT here. Email is the login
-- identity (auth.users); role moves only through the owner's invite control.
-- The Team tab shows both as static text.

create table if not exists public.provider_member_profiles (
  provider_id uuid not null references public.providers (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  full_name text,
  job_title text,
  phone text,
  updated_at timestamptz not null default now(),
  primary key (provider_id, user_id)
);

alter table public.provider_member_profiles enable row level security;

-- Any active member of the provider can read the whole team's basic details
-- (the roster is visible to everyone on the tab).
drop policy if exists "members read team profiles" on public.provider_member_profiles;
create policy "members read team profiles" on public.provider_member_profiles
  for select using (provider_id in (select public.user_provider_ids()));

-- A member may create / edit / clear their OWN row.
drop policy if exists "members write own profile" on public.provider_member_profiles;
create policy "members write own profile" on public.provider_member_profiles
  for all
  using (user_id = auth.uid() and provider_id in (select public.user_provider_ids()))
  with check (user_id = auth.uid() and provider_id in (select public.user_provider_ids()));

-- Owners and managers may edit anyone's row on their provider.
drop policy if exists "managers write team profiles" on public.provider_member_profiles;
create policy "managers write team profiles" on public.provider_member_profiles
  for all
  using (provider_id in (select public.user_manage_provider_ids()))
  with check (provider_id in (select public.user_manage_provider_ids()));
