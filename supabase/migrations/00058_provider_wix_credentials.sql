-- Per-vendor Wix credentials (Settings -> Integrate your Business), replacing
-- the single global WIX_ACCESS_TOKEN/WIX_SITE_ID env vars every provider used
-- to share. Each business now connects its own Wix account.
--
-- RLS is enabled with NO policies at all — anon and authenticated (including
-- the owning vendor's own session) can never select/insert/update/delete
-- this table directly. The only way in is app/api/vendor/wix-integration,
-- which authenticates the caller, checks their role on the provider via
-- requireProviderRole(), and then uses the service-role admin client (which
-- bypasses RLS) to do the actual read/write. The raw `wix_api_key` is never
-- sent to the browser except through the explicit /reveal action.
-- Idempotent.

create table if not exists public.provider_wix_credentials (
  provider_id uuid primary key references public.providers (id) on delete cascade,
  wix_site_id text not null,
  wix_api_key text not null,
  -- Safe-to-display form (e.g. the last 10 characters), computed at save
  -- time so the default status view never needs the real key at all.
  wix_api_key_preview text not null,
  updated_at timestamptz not null default now()
);

alter table public.provider_wix_credentials enable row level security;
