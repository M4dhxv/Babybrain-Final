-- BabyBrain Phase 1 — Row Level Security
-- Principle: parents read/write only their own rows; catalog data
-- (categories, activities, sessions, reviews) is publicly readable;
-- all admin/system writes go through the service role, which
-- bypasses RLS, so no admin policies are needed.
-- Idempotent: drop policy if exists before each create.

alter table public.parent_profiles      enable row level security;
alter table public.user_preferences     enable row level security;
alter table public.children             enable row level security;
alter table public.activity_categories  enable row level security;
alter table public.activities           enable row level security;
alter table public.activity_sessions    enable row level security;
alter table public.favorites            enable row level security;
alter table public.reviews              enable row level security;
alter table public.user_recommendations enable row level security;
alter table public.notifications        enable row level security;
alter table public.stream_users         enable row level security;
alter table public.bookings             enable row level security;

-- ---------- parent_profiles: own row only ----------
drop policy if exists "select own profile" on public.parent_profiles;
create policy "select own profile" on public.parent_profiles
  for select using (id = auth.uid());
drop policy if exists "update own profile" on public.parent_profiles;
create policy "update own profile" on public.parent_profiles
  for update using (id = auth.uid()) with check (id = auth.uid());
-- (insert happens in the auth trigger, which runs as definer)

-- ---------- user_preferences: own row only ----------
drop policy if exists "select own preferences" on public.user_preferences;
create policy "select own preferences" on public.user_preferences
  for select using (user_id = auth.uid());
drop policy if exists "update own preferences" on public.user_preferences;
create policy "update own preferences" on public.user_preferences
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------- children: full CRUD on own children ----------
drop policy if exists "select own children" on public.children;
create policy "select own children" on public.children
  for select using (parent_id = auth.uid());
drop policy if exists "insert own children" on public.children;
create policy "insert own children" on public.children
  for insert with check (parent_id = auth.uid());
drop policy if exists "update own children" on public.children;
create policy "update own children" on public.children
  for update using (parent_id = auth.uid()) with check (parent_id = auth.uid());
drop policy if exists "delete own children" on public.children;
create policy "delete own children" on public.children
  for delete using (parent_id = auth.uid());

-- ---------- catalog: public read, no client writes ----------
drop policy if exists "categories are public" on public.activity_categories;
create policy "categories are public" on public.activity_categories
  for select using (true);

drop policy if exists "published activities are public" on public.activities;
create policy "published activities are public" on public.activities
  for select using (is_published);

drop policy if exists "sessions of published activities are public" on public.activity_sessions;
create policy "sessions of published activities are public" on public.activity_sessions
  for select using (
    exists (
      select 1 from public.activities a
      where a.id = activity_id and a.is_published
    )
  );

-- ---------- favorites: own rows ----------
drop policy if exists "select own favorites" on public.favorites;
create policy "select own favorites" on public.favorites
  for select using (user_id = auth.uid());
drop policy if exists "insert own favorites" on public.favorites;
create policy "insert own favorites" on public.favorites
  for insert with check (user_id = auth.uid());
drop policy if exists "delete own favorites" on public.favorites;
create policy "delete own favorites" on public.favorites
  for delete using (user_id = auth.uid());

-- ---------- reviews: public read, write own ----------
drop policy if exists "reviews are public" on public.reviews;
create policy "reviews are public" on public.reviews
  for select using (true);
drop policy if exists "insert own review" on public.reviews;
create policy "insert own review" on public.reviews
  for insert with check (user_id = auth.uid());
drop policy if exists "update own review" on public.reviews;
create policy "update own review" on public.reviews
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "delete own review" on public.reviews;
create policy "delete own review" on public.reviews
  for delete using (user_id = auth.uid());

-- ---------- user_recommendations: read own; written only by the
--            security-definer compute function / service role ----------
drop policy if exists "select own recommendations" on public.user_recommendations;
create policy "select own recommendations" on public.user_recommendations
  for select using (user_id = auth.uid());

-- ---------- notifications: read own; clients may only flip read_at ----------
drop policy if exists "select own notifications" on public.notifications;
create policy "select own notifications" on public.notifications
  for select using (user_id = auth.uid());
drop policy if exists "update own notifications" on public.notifications;
create policy "update own notifications" on public.notifications
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- column-level guard: authenticated users can only update read_at
revoke update on public.notifications from authenticated;
grant update (read_at) on public.notifications to authenticated;

-- ---------- stream_users: read own; written server-side only ----------
drop policy if exists "select own stream mapping" on public.stream_users;
create policy "select own stream mapping" on public.stream_users
  for select using (user_id = auth.uid());

-- ---------- bookings: read own; no client writes in Phase 1 ----------
drop policy if exists "select own bookings" on public.bookings;
create policy "select own bookings" on public.bookings
  for select using (user_id = auth.uid());

-- =============================================================
-- Storage: 'activity-images' bucket — public read, admin-only write
-- (no insert/update policies for authenticated => only the service
--  role can upload)
-- =============================================================
insert into storage.buckets (id, name, public)
values ('activity-images', 'activity-images', true)
on conflict (id) do nothing;

drop policy if exists "activity images are public" on storage.objects;
create policy "activity images are public"
  on storage.objects for select
  using (bucket_id = 'activity-images');
