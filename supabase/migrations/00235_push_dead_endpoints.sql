-- 00235_push_dead_endpoints.sql
--
-- Self-healing Web Push subscriptions.
--
-- When a push service answers 404/410 for a subscription, the sender already
-- deletes that device's row (lib/push.ts). But the browser can still hold the
-- same dead subscription and quietly re-save it on the next visit, so the
-- device is removed again at the next send and the parent never gets a
-- notification on it, with nothing to say why.
--
-- This remembers the endpoints the push service has rejected:
--   * push_dead_endpoints is the log (which device, which status, when);
--   * save_push_subscription now refuses a remembered endpoint with the error
--     'push_endpoint_expired', and the app reacts by unsubscribing and creating
--     a fresh subscription.
--
-- The table is only ever touched by the service role (the sender) and by the
-- security-definer function below: RLS is on with no policies.
--
-- Idempotent.

begin;

create table if not exists public.push_dead_endpoints (
  endpoint    text primary key,
  user_id     uuid,
  status_code integer,
  reason      text,
  removed_at  timestamptz not null default now()
);

alter table public.push_dead_endpoints enable row level security;

comment on table public.push_dead_endpoints is
  'Push endpoints the push service rejected (404/410). Written by the notifications sender; read by save_push_subscription so a dead subscription is not re-registered.';

create or replace function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text)
returns void
language plpgsql
security definer set search_path = public
as $$
declare v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'Not authenticated';
  end if;

  if exists (select 1 from public.push_dead_endpoints where endpoint = p_endpoint) then
    raise exception 'push_endpoint_expired';
  end if;

  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth)
  values (v_user, p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update
    set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth;
end;
$$;

notify pgrst, 'reload schema';

commit;
