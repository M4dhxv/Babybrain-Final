-- 00023_notification_webhook_vault.sql
-- Fix the notification→email webhook for hosted Supabase.
--
-- Migration 00004 configured the webhook via `alter database postgres set
-- app.notification_webhook_url = ...`, but on hosted Supabase the `postgres`
-- role does not own the database, so that ALTER DATABASE is rejected
-- (ERROR 42501: permission denied to set parameter). Mirror the working
-- vendor-refresh cron (00021) instead: hardcode the app URL and read the
-- shared secret from Supabase Vault. No ALTER DATABASE, no committed secret.
--
-- Prerequisite: a Vault secret named 'cron_shared_secret' whose value equals
-- the app's WEBHOOK_SHARED_SECRET (the same secret the vendor cron already
-- uses). While the secret is missing the trigger no-ops and emails stay
-- email_status='pending' — nothing is sent.

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
    url     := 'https://babybrain-final.vercel.app/api/webhooks/notifications',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-webhook-secret', v_secret
    ),
    body    := jsonb_build_object('notification_id', new.id)
  );
  return new;
end;
$$;

-- (Re)attach the trigger. 00004 was meant to create it, but on the hosted DB
-- it is missing, so recreate it here idempotently — without it the function is
-- never called and notifications stay email_status='pending'.
drop trigger if exists on_notification_created on public.notifications;
create trigger on_notification_created
  after insert on public.notifications
  for each row execute function public.notify_email_webhook();
