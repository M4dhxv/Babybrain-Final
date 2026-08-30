-- 00073_wix_sync_orphan_sweep.sql
--
-- runWixScheduledSync (lib/wix/scheduled-sync.ts) inserts a wix_sync_runs
-- row at status='running' and only flips it to 'success'/'error' at the
-- end. When the Vercel function is killed at its maxDuration cap mid-run
-- (see the 00072 note — the events sync currently takes ~60s for two
-- providers), that row is never updated and sits at 'running' forever.
-- 152 such rows had accumulated by the time this was written.
--
-- This migration:
--   1. back-fills every stale 'running' row to 'error',
--   2. schedules a sweep (every 10 min) so future timed-out runs get
--      closed out the same way instead of piling up,
--   3. schedules a nightly prune so the run log doesn't grow unbounded.
--
-- All idempotent — safe to re-run.

create extension if not exists pg_cron;

-- 1. One-time back-fill of everything already orphaned.
update public.wix_sync_runs
set    status      = 'error',
       error       = coalesce(error, 'orphaned — sync function timed out before finishing'),
       finished_at = coalesce(finished_at, now())
where  status = 'running'
  and  started_at < now() - interval '5 minutes';

-- 2. Recurring sweep: anything still 'running' after 5 minutes is dead
--    (a healthy run finishes in well under that).
select cron.unschedule(jobid) from cron.job where jobname = 'wix-sync-sweep';

select cron.schedule(
  'wix-sync-sweep',
  '*/10 * * * *',
  $$
  update public.wix_sync_runs
  set    status      = 'error',
         error       = coalesce(error, 'orphaned — sync function timed out before finishing'),
         finished_at = coalesce(finished_at, now())
  where  status = 'running'
    and  started_at < now() - interval '5 minutes';
  $$
);

-- 3. Nightly prune — keep 14 days of run history.
select cron.unschedule(jobid) from cron.job where jobname = 'wix-sync-log-prune';

select cron.schedule(
  'wix-sync-log-prune',
  '17 3 * * *',
  $$
  delete from public.wix_sync_runs where started_at < now() - interval '14 days';
  $$
);
