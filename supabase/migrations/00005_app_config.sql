-- BabyBrain — app_config key/value store for deploy-time settings.
--
-- Supersedes the database-GUC approach in 00004 (Supabase's postgres
-- role lacks permission to ALTER DATABASE SET custom parameters).
-- The notification email trigger now reads its target URL + shared
-- secret from this table. RLS is enabled with NO policies: only the
-- service role and security-definer functions can read or write it.
--
-- Populate after deploy (service role):
--   insert into public.app_config (key, value) values
--     ('notification_webhook_url', 'https://<domain>/api/webhooks/notifications'),
--     ('webhook_shared_secret', '<WEBHOOK_SHARED_SECRET>')
--   on conflict (key) do update set value = excluded.value;

create table if not exists public.app_config (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

alter table public.app_config enable row level security;

create or replace function public.notify_email_webhook()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_url    text;
  v_secret text;
begin
  select value into v_url    from public.app_config where key = 'notification_webhook_url';
  select value into v_secret from public.app_config where key = 'webhook_shared_secret';

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
