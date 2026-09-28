-- 00190_chat_email_4h_and_fix_sender.sql
--
-- Chat reply emails ("New message") had never been sent on production. Two
-- separate faults, both needed fixing:
--
--   1. The Stream webhook rejected every delivery (fixed in
--      app/api/webhooks/stream/route.ts): Stream gzips hook payloads, the route
--      hashed the gzipped bytes, so the signature never matched and no chat
--      notification row was ever created.
--   2. This function, which re-posts chat notifications once they have sat
--      unread long enough, read app.notification_webhook_url — a database
--      setting hosted Supabase does not let us set (NULL on production). It
--      returned early on every hourly run, so even with (1) fixed every chat
--      email would have been held forever. 00189 noted this and left it.
--
-- Now it reads the URL and secret the same way as every other database-to-app
-- call (00189): public.app_base_url() and the `cron_shared_secret` Vault secret.
-- Depends on 00189 (app_base_url), which db push applies first.
--
-- Also: the hold goes from 8 hours to 4 (founder request, guide review 28 Sep),
-- and class group chat emails (class_group_message / provider_class_group_message,
-- new on 29 Sep) are held and sent the same way.
-- Keep in step with CHAT_EMAIL_DELAY_MS in app/api/webhooks/notifications/route.ts.
-- The cron is hourly at :05, so an unread message is emailed 4-5 hours later.
--
-- Applying this sends nothing by itself: production has no chat notification
-- rows at all (fault 1), so there is no backlog to flush.
--
-- Idempotent.

create or replace function public.send_pending_chat_emails()
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_secret text;
  r record;
begin
  select decrypted_secret into v_secret
    from vault.decrypted_secrets
    where name = 'cron_shared_secret';
  if v_secret is null or v_secret = '' then
    return;  -- same guard as notify_email_webhook(): not configured here
  end if;

  for r in
    select id from public.notifications
    where type in ('provider_message', 'provider_message_response',
                   'class_group_message', 'provider_class_group_message')
      and email_status = 'pending'
      and created_at <= now() - interval '4 hours'
      and created_at > now() - interval '7 days'
  loop
    perform net.http_post(
      url     := public.app_base_url() || '/api/webhooks/notifications',
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', v_secret),
      body    := jsonb_build_object('notification_id', r.id)
    );
  end loop;
end;
$$;
