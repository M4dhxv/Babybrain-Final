-- 00248_sync_payouts_cron.sql
--
-- Hourly safety net for providers.payouts_enabled: calls /api/cron/sync-payouts, which asks
-- Stripe about every vendor with a Stripe account but payouts off and corrects the flag.
--
-- Why: the flag normally turns on through Stripe's account.updated Connect webhook. On
-- production that webhook has not changed a flag since 31 Aug 2026 (the only trace it leaves,
-- a 'payouts_status' notification, stopped then), so flags only refreshed when someone from
-- the vendor opened Billing. Inspire Mum & Baby connected Stripe and still showed "no Stripe"
-- a day later (2026-10-21). This keeps the flag right whatever happens to that webhook.
--
-- Same shape as the other pg_cron -> pg_net jobs (00219): the app's base URL and the shared
-- cron secret from the vault.
--
-- Idempotent.

select cron.unschedule(jobid) from cron.job where jobname = 'sync-payouts';
select cron.schedule(
  'sync-payouts',
  '20 * * * *',
  $$
  select net.http_post(
    url     := public.app_base_url() || '/api/cron/sync-payouts',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_shared_secret')
    ),
    body    := '{}'::jsonb
  );
  $$
);
