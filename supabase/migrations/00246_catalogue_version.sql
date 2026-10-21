-- 00246_catalogue_version.sql
--
-- A single "catalogue version" stamp that changes whenever anything Explore shows
-- changes, so an edit reaches the Explore list at once instead of waiting out the
-- edge cache (app/api/explore/[fn]: 45s fresh + 2 min stale).
--
-- How it is used: /api/explore/version returns this stamp (edge-cached 2s), and
-- the parent app adds it to every /api/explore/<fn> request (?v=…). A new stamp is
-- a new URL, so the edge serves nothing cached from before the edit, while normal
-- browsing between edits still shares one cached answer per filter.
--
-- Bumped by a statement-level trigger on the tables Explore cards are built from,
-- whoever writes them: the admin editor, the vendor portal, the Wix sync, the
-- crawler. The stamp is a millisecond clock reading, not a counter, so it only
-- ever moves forward and needs no read before the write.
--
-- Not readable by anon/authenticated directly (RLS on, no policies): only the
-- server route reads it, with the service role.
--
-- Idempotent.

begin;

create table if not exists public.catalogue_version (
  id         int primary key default 1 check (id = 1),
  version    bigint not null default 0,
  updated_at timestamptz not null default now()
);
insert into public.catalogue_version (id, version)
values (1, (extract(epoch from clock_timestamp()) * 1000)::bigint)
on conflict (id) do nothing;

alter table public.catalogue_version enable row level security;

create or replace function public.bump_catalogue_version()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  update public.catalogue_version
     set version = greatest(version + 1, (extract(epoch from clock_timestamp()) * 1000)::bigint),
         updated_at = now()
   where id = 1;
  return null;
end;
$$;

-- Trigger functions can't be called over RPC, but keep the default-public grant off anyway.
revoke all on function public.bump_catalogue_version() from public, anon, authenticated;

drop trigger if exists catalogue_version_activities on public.activities;
create trigger catalogue_version_activities
  after insert or update or delete on public.activities
  for each statement execute function public.bump_catalogue_version();

drop trigger if exists catalogue_version_sessions on public.activity_sessions;
create trigger catalogue_version_sessions
  after insert or update or delete on public.activity_sessions
  for each statement execute function public.bump_catalogue_version();

drop trigger if exists catalogue_version_providers on public.providers;
create trigger catalogue_version_providers
  after insert or update or delete on public.providers
  for each statement execute function public.bump_catalogue_version();

drop trigger if exists catalogue_version_locations on public.provider_locations;
create trigger catalogue_version_locations
  after insert or update or delete on public.provider_locations
  for each statement execute function public.bump_catalogue_version();

commit;
