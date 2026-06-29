-- BabyBrain Phase 2 — Vendor RLS
-- Staff roles enforced via security-definer helper functions that read
-- provider_members for the current user (functions bypass RLS, so no
-- recursion). Parents never gain access to vendor-only data.

-- =============================================================
-- Helper functions (membership / role checks)
-- =============================================================
create or replace function public.user_provider_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select provider_id from public.provider_members
  where user_id = auth.uid() and status = 'active';
$$;

-- providers where the user is owner or manager (can manage content/bookings)
create or replace function public.user_manage_provider_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select provider_id from public.provider_members
  where user_id = auth.uid() and status = 'active' and role in ('owner','manager');
$$;

-- providers where the user is owner (can manage staff + billing)
create or replace function public.user_owner_provider_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select provider_id from public.provider_members
  where user_id = auth.uid() and status = 'active' and role = 'owner';
$$;

-- =============================================================
-- Enable RLS
-- =============================================================
alter table public.providers           enable row level security;
alter table public.provider_members    enable row level security;
alter table public.provider_locations  enable row level security;
alter table public.attendance          enable row level security;
alter table public.make_up_tokens      enable row level security;
alter table public.subscriptions       enable row level security;
alter table public.listing_events      enable row level security;

-- ---------------- providers ----------------
drop policy if exists "active providers are public" on public.providers;
create policy "active providers are public" on public.providers
  for select using (status = 'active' or id in (select user_provider_ids()));
drop policy if exists "create own provider" on public.providers;
create policy "create own provider" on public.providers
  for insert with check (owner_id = auth.uid());
drop policy if exists "managers update provider" on public.providers;
create policy "managers update provider" on public.providers
  for update using (id in (select user_manage_provider_ids()))
  with check (id in (select user_manage_provider_ids()));

-- ---------------- provider_members (staff) ----------------
drop policy if exists "members see their team" on public.provider_members;
create policy "members see their team" on public.provider_members
  for select using (provider_id in (select user_provider_ids()) or user_id = auth.uid());
drop policy if exists "owners manage staff" on public.provider_members;
create policy "owners manage staff" on public.provider_members
  for all using (provider_id in (select user_owner_provider_ids()))
  with check (provider_id in (select user_owner_provider_ids()));

-- ---------------- provider_locations ----------------
drop policy if exists "locations public for active providers" on public.provider_locations;
create policy "locations public for active providers" on public.provider_locations
  for select using (
    provider_id in (select user_provider_ids())
    or exists (select 1 from public.providers p where p.id = provider_id and p.status = 'active'));
drop policy if exists "managers write locations" on public.provider_locations;
create policy "managers write locations" on public.provider_locations
  for all using (provider_id in (select user_manage_provider_ids()))
  with check (provider_id in (select user_manage_provider_ids()));

-- ---------------- activities (extend Phase-1 policies) ----------------
-- Phase 1 already grants public select on published activities. Add
-- vendor visibility (incl. drafts) + manager write for own provider.
drop policy if exists "members see own activities" on public.activities;
create policy "members see own activities" on public.activities
  for select using (provider_id in (select user_provider_ids()));
drop policy if exists "managers insert activities" on public.activities;
create policy "managers insert activities" on public.activities
  for insert with check (provider_id in (select user_manage_provider_ids()));
drop policy if exists "managers update activities" on public.activities;
create policy "managers update activities" on public.activities
  for update using (provider_id in (select user_manage_provider_ids()))
  with check (provider_id in (select user_manage_provider_ids()));
drop policy if exists "managers delete activities" on public.activities;
create policy "managers delete activities" on public.activities
  for delete using (provider_id in (select user_manage_provider_ids()));

-- ---------------- activity_sessions (extend) ----------------
drop policy if exists "members see own sessions" on public.activity_sessions;
create policy "members see own sessions" on public.activity_sessions
  for select using (exists (
    select 1 from public.activities a
    where a.id = activity_id and a.provider_id in (select user_provider_ids())));
drop policy if exists "managers write sessions" on public.activity_sessions;
create policy "managers write sessions" on public.activity_sessions
  for all using (exists (
    select 1 from public.activities a
    where a.id = activity_id and a.provider_id in (select user_manage_provider_ids())))
  with check (exists (
    select 1 from public.activities a
    where a.id = activity_id and a.provider_id in (select user_manage_provider_ids())));

-- ---------------- bookings (extend) ----------------
-- Phase 1: parents select own. Add parent self-insert + vendor access.
drop policy if exists "parent creates own booking" on public.bookings;
create policy "parent creates own booking" on public.bookings
  for insert with check (user_id = auth.uid());
drop policy if exists "members see provider bookings" on public.bookings;
create policy "members see provider bookings" on public.bookings
  for select using (provider_id in (select user_provider_ids()));
drop policy if exists "managers update bookings" on public.bookings;
create policy "managers update bookings" on public.bookings
  for update using (provider_id in (select user_manage_provider_ids()))
  with check (provider_id in (select user_manage_provider_ids()));

-- ---------------- attendance (staff may mark; any member may read) ----------------
drop policy if exists "members read attendance" on public.attendance;
create policy "members read attendance" on public.attendance
  for select using (exists (
    select 1 from public.bookings b
    where b.id = booking_id and b.provider_id in (select user_provider_ids())));
drop policy if exists "staff write attendance" on public.attendance;
create policy "staff write attendance" on public.attendance
  for all using (exists (
    select 1 from public.bookings b
    where b.id = booking_id and b.provider_id in (select user_provider_ids())))
  with check (exists (
    select 1 from public.bookings b
    where b.id = booking_id and b.provider_id in (select user_provider_ids())));

-- ---------------- make_up_tokens (vendor manages; parent reads own) ----------------
drop policy if exists "members manage tokens" on public.make_up_tokens;
create policy "members manage tokens" on public.make_up_tokens
  for all using (provider_id in (select user_provider_ids()))
  with check (provider_id in (select user_provider_ids()));
drop policy if exists "parent reads own tokens" on public.make_up_tokens;
create policy "parent reads own tokens" on public.make_up_tokens
  for select using (user_id = auth.uid());

-- ---------------- subscriptions (owner reads; Stripe webhook writes via service role) ----------------
drop policy if exists "members read subscription" on public.subscriptions;
create policy "members read subscription" on public.subscriptions
  for select using (provider_id in (select user_provider_ids()));

-- ---------------- listing_events (anyone may log a view; members read) ----------------
drop policy if exists "anyone logs a view" on public.listing_events;
create policy "anyone logs a view" on public.listing_events
  for insert with check (type in ('profile_view','listing_view','booking_click'));
drop policy if exists "members read events" on public.listing_events;
create policy "members read events" on public.listing_events
  for select using (provider_id in (select user_provider_ids()));
