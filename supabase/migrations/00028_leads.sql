-- 00028_leads.sql
-- Captured email leads from the "start exploring" popup on the parent site.
-- Anonymous visitors may submit their email; nobody can read the list via the
-- API (no select policy → service-role / admin only), so it can't be scraped.

create table if not exists public.leads (
  id                uuid primary key default gen_random_uuid(),
  email             text not null,
  source            text,                 -- e.g. 'explore-popup'
  child_age_months  int,                  -- optional context if we ever pass it
  created_at        timestamptz not null default now()
);

create index if not exists leads_email_idx on public.leads (lower(email));
create index if not exists leads_created_idx on public.leads (created_at desc);

alter table public.leads enable row level security;

-- Anyone (signed in or not) may submit a lead with a non-empty email.
-- Reads are intentionally not granted to any client role.
drop policy if exists "anyone can submit a lead" on public.leads;
create policy "anyone can submit a lead"
  on public.leads
  for insert
  to anon, authenticated
  with check (char_length(trim(email)) > 3);
