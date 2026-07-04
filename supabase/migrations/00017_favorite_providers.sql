-- BabyBrain — let parents save favourite providers (in addition to activities).
-- Mirrors public.favorites. Parents manage their own rows. Idempotent.

create table if not exists public.favorite_providers (
  user_id uuid not null references public.parent_profiles (id) on delete cascade,
  provider_id uuid not null references public.providers (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, provider_id)
);

alter table public.favorite_providers enable row level security;

drop policy if exists "select own provider favorites" on public.favorite_providers;
create policy "select own provider favorites" on public.favorite_providers
  for select using (user_id = auth.uid());

drop policy if exists "insert own provider favorites" on public.favorite_providers;
create policy "insert own provider favorites" on public.favorite_providers
  for insert with check (user_id = auth.uid());

drop policy if exists "delete own provider favorites" on public.favorite_providers;
create policy "delete own provider favorites" on public.favorite_providers
  for delete using (user_id = auth.uid());
