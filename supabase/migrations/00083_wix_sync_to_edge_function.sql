-- 00083_wix_sync_to_edge_function.sql
--
-- Re-points the wix-sync cron (00072) from the Vercel-hosted
-- /api/cron/refresh-wix route to a Supabase Edge Function
-- (supabase/functions/wix-sync) doing the identical work, and widens the
-- interval from every 5 minutes to every 15.
--
-- Why: pg_cron only schedules the call — the actual compute (a Wix API call
-- per connected provider, mostly spent idle-waiting on the network) was
-- running as a Vercel serverless function, 24/7, regardless of site traffic,
-- and billed there. Moving the target to an Edge Function moves that compute
-- (and its cost) onto Supabase's own infrastructure instead. The interval
-- widen is a second, independent cut: live run history showed each run
-- averaging ~37s for 2 providers — at every 5 minutes that's ~89 hours of
-- function time a month for a job nothing about site traffic drives; every
-- 15 minutes is a 3x reduction in invocations for the exact same coverage.
--
-- The Vercel route (app/api/cron/refresh-wix/route.ts) and its manual
-- /admin trigger are left completely alone — only the cron's target URL
-- changes. Rolling back is a one-line revert of the `url :=` value below.
--
-- Requires, before this actually starts working (see the Edge Function's
-- own doc comment for the exact commands):
--   1. supabase functions deploy wix-sync --no-verify-jwt
--   2. supabase secrets set CRON_SHARED_SECRET=<same value as Vercel's
--      WEBHOOK_SHARED_SECRET env var / this project's existing
--      'cron_shared_secret' Vault entry>
-- Until both are done, this cron's calls will fail (404 before the deploy,
-- 401 before the secret is set) — harmlessly: wix-sync-sweep (00073) already
-- closes out a run that never completes, the same safety net that already
-- covers a Vercel-side timeout today.

select cron.unschedule(jobid) from cron.job where jobname = 'wix-sync';

select cron.schedule(
  'wix-sync',
  '*/15 * * * *',                        -- was */5 (00072) — see note above
  $$
  select net.http_post(
    url     := 'https://laftgypwwfevzggxknii.supabase.co/functions/v1/wix-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      -- Reuses the same Vault secret the Vercel route was checking against
      -- (WEBHOOK_SHARED_SECRET there) — the Edge Function checks it against
      -- its own CRON_SHARED_SECRET function secret instead, which has to be
      -- set to this same string (see the deploy notes above).
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_shared_secret')
    ),
    body    := '{}'::jsonb
  );
  $$
);

notify pgrst, 'reload schema';
