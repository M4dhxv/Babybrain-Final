-- 00157_wix_sync_locks.sql
--
-- Bug audit (2026-09-20): syncWixServicesToActivities and syncProviderWixEvents
-- do check-then-insert location dedup (query provider_locations, insert if not
-- found) with no lock across two separate top-level runs for the same
-- provider — the 15-minute pg_cron sync vs. a vendor manually clicking "Sync
-- services"/"Sync events" at the same time. Two overlapping runs can each miss
-- the other's uncommitted insert for a new location and create duplicate rows
-- (events path — no unique constraint on address text), or the losing insert
-- can fail its unique constraint silently and write a null location onto an
-- activity (bookings path — resolveWixServiceLocation doesn't check that
-- insert's error).
--
-- A native Postgres advisory lock (pg_advisory_lock) doesn't work here: these
-- functions run as a series of separate PostgREST/supabase-js calls, each of
-- which can land on a different pooled connection, so a session-scoped lock
-- acquired on one request's connection isn't held by the time the next
-- request in the same JS function runs. This table is the same
-- shared-state-via-row pattern the rate limiter (00087) already uses for
-- exactly that reason.
--
-- Idempotent.

create table if not exists public.wix_sync_locks (
  provider_id uuid primary key references public.providers (id) on delete cascade,
  locked_at timestamptz not null default now(),
  locked_by text
);

comment on table public.wix_sync_locks is
  'One row per provider currently running a Wix sync (services or events) — held for the duration of syncWixServicesToActivities/syncProviderWixEvents so the 15-min cron and a manual sync click for the same provider serialize instead of racing provider_locations dedup. Service-role only.';

alter table public.wix_sync_locks enable row level security;
-- No policies: service-role only, same as rate_limit_hits.
