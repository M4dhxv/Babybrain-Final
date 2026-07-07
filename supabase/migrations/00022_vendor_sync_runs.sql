-- 00022_vendor_sync_runs.sql
-- Persistent log of vendor directory-refresh runs (the weekly pg_cron job AND
-- manual triggers from /admin) so the founder can see, per run, what was
-- checked, what got updated, and what couldn't be pulled. Service-role only:
-- RLS is enabled with no policies, so only the admin client (behind the
-- ADMIN_EMAILS gate) can read or write it.

create table if not exists public.vendor_sync_runs (
  id              uuid primary key default gen_random_uuid(),
  trigger         text not null default 'cron' check (trigger in ('cron', 'manual')),
  status          text not null default 'running' check (status in ('running', 'success', 'error')),
  triggered_by    text,                      -- admin email for manual runs; null for cron
  checked         integer not null default 0,
  wp_sites        integer not null default 0,
  prices_updated  integer not null default 0,
  results         jsonb   not null default '[]'::jsonb,  -- per-vendor outcomes
  error           text,                      -- set only if the whole run threw
  started_at      timestamptz not null default now(),
  finished_at     timestamptz
);

create index if not exists vendor_sync_runs_started_idx
  on public.vendor_sync_runs (started_at desc);

alter table public.vendor_sync_runs enable row level security;
-- Intentionally no policies — access is service-role only via the admin API.
