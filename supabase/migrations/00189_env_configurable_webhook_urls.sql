-- 00189_env_configurable_webhook_urls.sql
--
-- Every database-to-app call (notification emails, chat sync, the email retry
-- job, the weekly vendor refresh and the Wix sync cron) had the PRODUCTION host
-- hardcoded in its migration. The test database runs the same migrations, so it
-- inherited them: its notification trigger posted to production's app (which
-- can't find a test notification id, so the email was never sent), and its
-- `wix-sync` and `weekly-vendor-refresh` cron jobs called production's edge
-- function and app. The test project never ran a scheduled Wix sync for that
-- reason (wix_sync_runs empty).
--
-- This makes the two base URLs per-environment, read from Vault at call time:
--
--   app_base_url        e.g. https://babybrain-test.vercel.app   (no trailing /)
--   functions_base_url  e.g. https://<ref>.supabase.co/functions/v1
--
-- With neither secret set, the helpers return today's production values, so
-- APPLYING THIS TO PRODUCTION CHANGES NOTHING. On the test project, create the
-- two secrets BEFORE applying (otherwise the test DB keeps calling production):
--
--   select vault.create_secret('https://babybrain-test.vercel.app', 'app_base_url');
--   select vault.create_secret('https://imlfhepnucytyajxpoum.supabase.co/functions/v1', 'functions_base_url');
--
-- The x-webhook-secret / x-cron-secret still come from the existing
-- `cron_shared_secret` Vault secret and must still equal the target app's
-- WEBHOOK_SHARED_SECRET (and the edge function's CRON_SHARED_SECRET).
--
-- Redefined here, unchanged except for the URL expression:
--   notify_email_webhook()              00023
--   bookings_chat_sync()                00147
--   retry_failed_notification_emails()  00187
--   cron jobs weekly-vendor-refresh (00021) and wix-sync (00083), same schedules
--
-- Deliberately NOT changed: send_pending_chat_emails() (00142) reads the
-- database setting app.notification_webhook_url, which hosted Supabase does not
-- allow setting, so it likely returns early on every run. Fixing that would
-- start re-sending held chat emails on production, which is a separate decision.
--
-- Idempotent.

begin;

-- =============================================================
-- Helpers
-- =============================================================
create or replace function public.app_base_url()
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v text;
begin
  select nullif(btrim(decrypted_secret), '') into v
    from vault.decrypted_secrets where name = 'app_base_url';
  if v is null then
    return 'https://babybrain-final.vercel.app';
  end if;
  v := regexp_replace(v, '/+$', '');
  if v !~ '^https://[A-Za-z0-9.-]+(:[0-9]+)?$' then
    -- Never raise: this runs inside triggers on notifications and bookings, and
    -- a bad value must not block those writes. Fall back to the default.
    raise warning 'app_base_url vault secret is not a plain https origin; using the default';
    return 'https://babybrain-final.vercel.app';
  end if;
  return v;
end;
$$;

create or replace function public.functions_base_url()
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v text;
begin
  select nullif(btrim(decrypted_secret), '') into v
    from vault.decrypted_secrets where name = 'functions_base_url';
  if v is null then
    return 'https://laftgypwwfevzggxknii.supabase.co/functions/v1';
  end if;
  v := regexp_replace(v, '/+$', '');
  if v !~ '^https://[A-Za-z0-9.-]+(:[0-9]+)?/functions/v1$' then
    raise warning 'functions_base_url vault secret is not https://<host>/functions/v1; using the default';
    return 'https://laftgypwwfevzggxknii.supabase.co/functions/v1';
  end if;
  return v;
end;
$$;

revoke all on function public.app_base_url() from public, anon, authenticated;
revoke all on function public.functions_base_url() from public, anon, authenticated;
grant execute on function public.app_base_url() to postgres, service_role;
grant execute on function public.functions_base_url() to postgres, service_role;

-- =============================================================
-- Notification email webhook (00023)
-- =============================================================
create or replace function public.notify_email_webhook()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_secret text;
begin
  select decrypted_secret into v_secret
    from vault.decrypted_secrets
    where name = 'cron_shared_secret';

  if v_secret is null or v_secret = '' then
    return new;  -- webhook secret not configured yet; email stays 'pending'
  end if;

  perform net.http_post(
    url     := public.app_base_url() || '/api/webhooks/notifications',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-webhook-secret', v_secret
    ),
    body    := jsonb_build_object('notification_id', new.id)
  );
  return new;
end;
$$;

-- =============================================================
-- Class group chat sync trigger (00147)
-- =============================================================
create or replace function public.bookings_chat_sync()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_secret text;
  v_sessions jsonb;
begin
  if new.user_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and old.status is not distinct from new.status
     and old.session_id is not distinct from new.session_id then
    return new;
  end if;

  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'cron_shared_secret';
  if v_secret is null or v_secret = '' then
    return new;
  end if;

  v_sessions := to_jsonb(array(
    select distinct s from unnest(
      case when tg_op = 'UPDATE' then array[old.session_id, new.session_id]
           else array[new.session_id] end
    ) as s where s is not null
  ));

  begin
    perform net.http_post(
      url     := public.app_base_url() || '/api/webhooks/booking-chat',
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', v_secret),
      body    := jsonb_build_object('user_id', new.user_id, 'session_ids', v_sessions)
    );
  exception when others then
    -- Never let a chat-sync hiccup block a booking write.
    raise warning 'bookings_chat_sync failed: %', sqlerrm;
  end;
  return new;
end;
$$;

-- =============================================================
-- Retry of failed notification emails (00187)
-- =============================================================
create or replace function public.retry_failed_notification_emails()
returns int
language plpgsql
security definer set search_path = public
as $$
declare
  v_secret text;
  v_id     uuid;
  v_n      int := 0;
begin
  select decrypted_secret into v_secret
    from vault.decrypted_secrets
    where name = 'cron_shared_secret';
  if v_secret is null or v_secret = '' then
    return 0;  -- same guard as notify_email_webhook(): not configured here
  end if;

  for v_id in
    update public.notifications
       set email_status = 'pending',
           email_attempts = email_attempts + 1
     where id in (
       select id from public.notifications
        where email_status = 'failed'
          and email_attempts < 3
          and created_at > now() - interval '24 hours'
        order by created_at
        limit 50
        for update skip locked
     )
    returning id
  loop
    perform net.http_post(
      url     := public.app_base_url() || '/api/webhooks/notifications',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-webhook-secret', v_secret
      ),
      body    := jsonb_build_object('notification_id', v_id)
    );
    v_n := v_n + 1;
  end loop;

  return v_n;
end;
$$;

revoke all on function public.retry_failed_notification_emails() from public, anon, authenticated;

-- =============================================================
-- Cron jobs that call a URL (00021, 00083) - same schedules as live
-- =============================================================
select cron.unschedule(jobid) from cron.job where jobname = 'weekly-vendor-refresh';
select cron.schedule(
  'weekly-vendor-refresh',
  '0 3 * * 1',
  $$
  select net.http_post(
    url     := public.app_base_url() || '/api/cron/refresh-vendors',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_shared_secret')
    ),
    body    := '{}'::jsonb
  );
  $$
);

select cron.unschedule(jobid) from cron.job where jobname = 'wix-sync';
select cron.schedule(
  'wix-sync',
  '*/15 * * * *',
  $$
  select net.http_post(
    url     := public.functions_base_url() || '/wix-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      -- Same Vault secret the Vercel route checks (WEBHOOK_SHARED_SECRET there);
      -- the edge function checks it against its CRON_SHARED_SECRET function
      -- secret, which must be set to this same string.
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_shared_secret')
    ),
    body    := '{}'::jsonb
  );
  $$
);

notify pgrst, 'reload schema';

commit;
