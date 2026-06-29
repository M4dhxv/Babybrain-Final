-- BabyBrain Phase 2 — Pending staff invites
-- Lets an owner invite someone who hasn't signed up yet; the invite is
-- consumed (→ provider_members) automatically on their first signup.
-- Idempotent.

create table if not exists public.provider_invites (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references public.providers (id) on delete cascade,
  email text not null,
  role text not null check (role in ('manager','staff')),
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (provider_id, email)
);

create index if not exists provider_invites_email_idx on public.provider_invites (lower(email))
  where accepted_at is null;

alter table public.provider_invites enable row level security;

drop policy if exists "owners manage invites" on public.provider_invites;
create policy "owners manage invites" on public.provider_invites
  for all using (provider_id in (select public.user_owner_provider_ids()))
  with check (provider_id in (select public.user_owner_provider_ids()));

-- Extend the existing signup trigger to also accept pending vendor invites.
-- (Keeps Phase 1 behaviour: still creates parent_profiles + preferences +
--  welcome notification for every new auth user.)
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.parent_profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'full_name', ''))
  on conflict (id) do nothing;

  insert into public.user_preferences (user_id) values (new.id)
  on conflict (user_id) do nothing;

  insert into public.notifications (user_id, type, title, body, data)
  values (new.id, 'welcome', 'Welcome to BabyBrain!',
    'Tell us about your child to get personalised activity recommendations.',
    '{"url": "/onboarding"}');

  -- Consume any pending vendor staff invites for this email.
  insert into public.provider_members (provider_id, user_id, role, status, invited_email)
  select i.provider_id, new.id, i.role, 'active', i.email
  from public.provider_invites i
  where lower(i.email) = lower(new.email) and i.accepted_at is null
  on conflict (provider_id, user_id) do nothing;

  update public.provider_invites
  set accepted_at = now()
  where lower(email) = lower(new.email) and accepted_at is null;

  return new;
end;
$$;
