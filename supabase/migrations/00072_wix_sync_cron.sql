-- 00072_wix_sync_cron.sql
--
-- 24/7 background sync for every vendor's connected Wix account (Bookings +
-- Events), independent of the vendor ever logging into the portal. Until now
-- the only thing that kept a listing's Wix-sourced price/capacity/location up
-- to date was the vendor manually clicking "Sync services" — a change made
-- directly on Wix (new ticket price, event moved, service archived) sat
-- stale on the parent-facing site until that next manual click.
--
-- Mirrors the existing weekly-vendor-refresh cron (00021/00022): pg_cron
-- fires on a schedule and, via pg_net, POSTs to /api/cron/refresh-wix, which
-- loops every row in provider_wix_credentials and re-runs the same sync
-- functions the manual "Sync services" button uses. The shared secret is
-- read from the same Vault entry ('cron_shared_secret') the vendor-refresh
-- cron already relies on — no new secret to configure.
--
-- Every minute: the cron fires exactly one fire-and-forget net.http_post
-- per tick — the per-provider fan-out happens inside
-- /api/cron/refresh-wix on Vercel — so tightening the schedule does not
-- scale with vendor count, and near-real-time price/capacity/location
-- freshness on the parent site is worth more as the marketplace grows.
-- The one real cost of going this tight: a provider with a bad/revoked
-- key re-attempts FEE_ADDED_AT_CHECKOUT fee discovery (which briefly
-- reserves one unit of live inventory to discover the fee rate — see
-- fetchTicketFeeRatePercent in lib/wix/client.ts) on every tick until the
-- key is fixed. For a gentler cadence, use '90 seconds' below (needs
-- pg_cron >= 1.5, which Supabase runs).

create table if not exists public.wix_sync_runs (
  id                 uuid primary key default gen_random_uuid(),
  trigger            text not null default 'cron' check (trigger in ('cron', 'manual')),
  status             text not null default 'running' check (status in ('running', 'success', 'error')),
  triggered_by       text,                      -- admin email for manual runs; null for cron
  providers_checked  integer not null default 0,
  providers_failed   integer not null default 0,
  services_created   integer not null default 0,
  services_updated   integer not null default 0,
  events_created     integer not null default 0,
  events_updated     integer not null default 0,
  results            jsonb   not null default '[]'::jsonb,  -- per-provider outcomes
  error              text,                      -- set only if the whole run threw
  started_at         timestamptz not null default now(),
  finished_at        timestamptz
);

create index if not exists wix_sync_runs_started_idx
  on public.wix_sync_runs (started_at desc);

alter table public.wix_sync_runs enable row level security;
-- Intentionally no policies — access is service-role only via the admin API.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Idempotent: drop a previous schedule before (re)creating it.
select cron.unschedule(jobid) from cron.job where jobname = 'wix-sync';

select cron.schedule(
  'wix-sync',
  '* * * * *',                           -- every minute
  $$
  select net.http_post(
    url     := 'https://babybrain-final.vercel.app/api/cron/refresh-wix',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_shared_secret')
    ),
    body    := '{}'::jsonb
  );
  $$
);
