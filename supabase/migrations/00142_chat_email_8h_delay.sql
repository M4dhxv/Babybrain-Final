-- Chat reply emails (provider_message / provider_message_response) are now held
-- until the message has been unread for 8 hours. The notifications webhook
-- defers them (leaves email_status 'pending'), and skips them if the recipient
-- read the message. This hourly job re-posts the ones old enough to send.

create or replace function public.send_pending_chat_emails()
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_url    text := current_setting('app.notification_webhook_url', true);
  v_secret text := current_setting('app.webhook_shared_secret', true);
  r record;
begin
  if v_url is null or v_url = '' then return; end if;
  for r in
    select id from public.notifications
    where type in ('provider_message', 'provider_message_response')
      and email_status = 'pending'
      and created_at <= now() - interval '8 hours'
      and created_at > now() - interval '7 days'
  loop
    perform net.http_post(
      url     := v_url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', coalesce(v_secret, '')),
      body    := jsonb_build_object('notification_id', r.id)
    );
  end loop;
end;
$$;

select cron.unschedule(jobid) from cron.job where jobname = 'send-pending-chat-emails';
select cron.schedule('send-pending-chat-emails', '5 * * * *', $$select public.send_pending_chat_emails();$$);
