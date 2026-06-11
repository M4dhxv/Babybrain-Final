-- BabyBrain Phase 1 — Notification email fan-out
--
-- Every INSERT into public.notifications fires an async HTTP POST
-- (via pg_net) to the app's /api/webhooks/notifications route, which
-- sends the email through Resend and updates email_status.
--
-- The target URL and shared secret are database-level settings so no
-- code change is needed at deploy time. Until they are set, the
-- trigger no-ops and notifications stay email_status='pending'.
--
-- Set after deploying the app (run once in the SQL editor):
--   alter database postgres set app.notification_webhook_url
--     = 'https://<your-domain>/api/webhooks/notifications';
--   alter database postgres set app.webhook_shared_secret = '<WEBHOOK_SHARED_SECRET>';

create extension if not exists pg_net;

create or replace function public.notify_email_webhook()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_url    text := current_setting('app.notification_webhook_url', true);
  v_secret text := current_setting('app.webhook_shared_secret', true);
begin
  if v_url is null or v_url = '' then
    return new;  -- webhook not configured yet; email stays 'pending'
  end if;

  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-webhook-secret', coalesce(v_secret, '')
    ),
    body    := jsonb_build_object('notification_id', new.id)
  );
  return new;
end;
$$;

drop trigger if exists on_notification_created on public.notifications;
create trigger on_notification_created
  after insert on public.notifications
  for each row execute function public.notify_email_webhook();
