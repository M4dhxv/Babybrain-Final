-- 00168_push_subscriptions.sql
--
-- Web Push subscriptions for parents who've installed the app as a PWA
-- (frontends/parent only offers the subscribe prompt when isStandalone()
-- is true — regular browser-tab visitors never get one). One row per
-- browser/device subscription; a parent with several installs gets several
-- rows, and the notifications webhook (app/api/webhooks/notifications)
-- pushes to all of a user's rows.
--
-- Same pattern as package_purchases (00019): parents can read their own
-- rows, but there is no insert/update/delete policy — all writes go through
-- the SECURITY DEFINER functions below, keyed off auth.uid() so a parent can
-- only ever touch their own subscriptions.
--
-- Idempotent.

begin;

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.parent_profiles (id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;

drop policy if exists "read own push subscriptions" on public.push_subscriptions;
create policy "read own push subscriptions" on public.push_subscriptions
  for select using (user_id = auth.uid());

-- Upsert on endpoint: the browser hands back the same endpoint for an
-- existing subscription, and a fresh one if it ever rotates (e.g. after the
-- SW updates its VAPID key) — either way this keeps exactly one row per
-- endpoint, re-owned to whoever is currently signed in on that device.
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

  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth)
  values (v_user, p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update
    set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth;
end;
$$;
grant execute on function public.save_push_subscription(text, text, text) to authenticated;

create or replace function public.delete_push_subscription(p_endpoint text)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  delete from public.push_subscriptions where endpoint = p_endpoint and user_id = auth.uid();
end;
$$;
grant execute on function public.delete_push_subscription(text) to authenticated;

notify pgrst, 'reload schema';

commit;
