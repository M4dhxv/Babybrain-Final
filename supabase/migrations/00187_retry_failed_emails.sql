-- 00187_retry_failed_emails.sql
--
-- A notification email that failed was marked 'failed' and never tried again.
-- On 28 Sep the Resend daily quota ran out mid-afternoon and everything after
-- it was lost for good, including a parent's class reminder (reminders are
-- stamped reminded_at when queued, so the reminder job never re-queues one).
--
-- Every 30 minutes, failed emails from the last 24 hours are put back to
-- 'pending' and re-posted to the notifications webhook, exactly the way
-- notify_email_webhook() posts a new one. The webhook only acts on 'pending'
-- rows, so a concurrent delivery can't double-send. At most 3 retries per
-- notification; anything older than 24 hours is left alone (a day-old booking
-- email is worse than none).
--
-- Idempotent.

alter table public.notifications
  add column if not exists email_attempts int not null default 0;

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
      url     := 'https://babybrain-final.vercel.app/api/webhooks/notifications',
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

do $$
begin
  if exists (select 1 from cron.job where jobname = 'retry-failed-emails') then
    perform cron.unschedule('retry-failed-emails');
  end if;
  perform cron.schedule(
    'retry-failed-emails',
    '*/30 * * * *',
    'select public.retry_failed_notification_emails();'
  );
end;
$$;
