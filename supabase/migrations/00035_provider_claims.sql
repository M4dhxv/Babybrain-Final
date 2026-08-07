-- 00035: Claim Your Business — real search + verification.
--
-- QA (all High):
--   * "claim your business, search function doesn't work"
--   * "claim your business, no code sent to e-mail and phone"
--   * "claim your business, can't edit listing details when click little pen"
--
-- The claim page was a static mock. This adds the state it needs: a claim
-- attempt row holding hashed one-time codes, and a search function parents of
-- the portal can call before they have an account.

begin;

-- =============================================================
-- 1. Claim attempts
-- =============================================================
create table if not exists public.provider_claims (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references public.providers (id) on delete cascade,
  -- Set once the claimer has an account; null while they're still verifying.
  claimed_by uuid references auth.users (id) on delete set null,
  contact_email text not null,
  contact_phone text,
  uen text,
  -- Codes are stored hashed so a leaked row can't be used to claim a business.
  email_code_hash text,
  phone_code_hash text,
  email_verified_at timestamptz,
  phone_verified_at timestamptz,
  expires_at timestamptz not null default now() + interval '30 minutes',
  attempts int not null default 0,
  status text not null default 'pending' check (status in ('pending', 'verified', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists provider_claims_provider_idx on public.provider_claims (provider_id);
create index if not exists provider_claims_email_idx on public.provider_claims (lower(contact_email));

drop trigger if exists set_updated_at on public.provider_claims;
create trigger set_updated_at before update on public.provider_claims
  for each row execute function public.set_updated_at();

alter table public.provider_claims enable row level security;

-- Claims are written only by the service role (the claim API routes), which
-- bypasses RLS. A signed-in claimer may read back their own attempt to see
-- which channels are verified; nobody can read the code hashes usefully since
-- they're hashes, but we still scope reads to the claimer.
drop policy if exists "claimers read own claim" on public.provider_claims;
create policy "claimers read own claim" on public.provider_claims
  for select using (claimed_by = auth.uid());

-- =============================================================
-- 2. Venue search for the claim page
-- =============================================================
-- Runs before the claimer has an account, so it's security definer and returns
-- only the public-facing fields. Already-claimed businesses are excluded:
-- there is nothing to claim, and it stops the page confirming who owns what.
create or replace function public.search_claimable_providers(p_query text, p_limit int default 10)
returns table (
  id uuid,
  business_name text,
  address text,
  postal_code text,
  region text,
  vendor_category text,
  logo_url text,
  activity_count int
)
language sql
stable
security definer
set search_path = public
as $$
  select
    p.id, p.business_name, p.address, p.postal_code, p.region, p.vendor_category, p.logo_url,
    (select count(*)::int from public.activities a
      where a.provider_id = p.id and a.is_published)
  from public.providers p
  where coalesce(p.is_claimed, false) = false
    and p.status <> 'suspended'
    and (
      p_query is null
      or length(trim(p_query)) < 2
      or p.business_name ilike '%' || trim(p_query) || '%'
      or p.address       ilike '%' || trim(p_query) || '%'
      or p.postal_code   ilike trim(p_query) || '%'
    )
  order by
    -- Prefer a name that starts with what they typed.
    (p.business_name ilike trim(coalesce(p_query, '')) || '%') desc,
    p.business_name
  limit greatest(1, least(p_limit, 25));
$$;

revoke all on function public.search_claimable_providers(text, int) from public;
grant execute on function public.search_claimable_providers(text, int) to anon, authenticated;

commit;
