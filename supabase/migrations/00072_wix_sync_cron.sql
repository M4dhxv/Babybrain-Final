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
-- Every 5 minutes. Do NOT tighten this yet: syncProviderWixEvents
-- (lib/wix/events-sync.ts) walks a 365-day window with a serial Wix API
-- call + Supabase round-trips per event, so a single run already takes
-- ~55-65s for just two providers and frequently hits the route's
-- maxDuration cap, orphaning its wix_sync_runs row at status='running'.
-- A tick interval shorter than the run time just stacks overlapping runs
-- that time out. Once events-sync is parallelised (concurrency-capped
-- per-event fan-out, bulk reads, shorter window) a run drops to a few
-- seconds and a 1-minute schedule becomes safe.
--
-- 00073 adds a sweep that closes out orphaned 'running' rows, so a
-- timed-out run no longer sits visible forever.

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
  '*/5 * * * *',                         -- every 5 minutes (see note above)
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
