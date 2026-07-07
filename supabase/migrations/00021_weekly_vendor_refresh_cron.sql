-- BabyBrain — weekly refresh of auto-listed vendor directory data.
-- pg_cron fires weekly and, via pg_net, POSTs to the app's
-- /api/cron/refresh-vendors route (which pulls WP data + stamps synced_at,
-- only for unclaimed auto-listings). The shared secret is read from Supabase
-- Vault at run time, so no secret is committed here.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Idempotent: drop a previous schedule before (re)creating it.
select cron.unschedule(jobid) from cron.job where jobname = 'weekly-vendor-refresh';

select cron.schedule(
  'weekly-vendor-refresh',
  '0 3 * * 1',                          -- every Monday 03:00 UTC (~11am SGT)
  $$
  select net.http_post(
    url     := 'https://babybrain-final.vercel.app/api/cron/refresh-vendors',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_shared_secret')
    ),
    body    := '{}'::jsonb
  );
  $$
);
