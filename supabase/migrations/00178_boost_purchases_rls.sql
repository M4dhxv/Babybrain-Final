-- 00178_boost_purchases_rls.sql
--
-- Supabase linter (2026-09-26): public.boost_purchases has RLS disabled,
-- so anon/authenticated roles could read the whole ledger via PostgREST.
-- Same shape as provider_earnings (00051_commercials_and_earnings.sql):
-- members read their own provider's rows, nobody writes from the client
-- (only the Stripe webhook writes, via the service role, which bypasses RLS).
--
-- Idempotent.

alter table public.boost_purchases enable row level security;

drop policy if exists "members read own boost purchases" on public.boost_purchases;
create policy "members read own boost purchases" on public.boost_purchases
  for select using (exists (
    select 1 from public.activities a
    where a.id = activity_id and a.provider_id in (select user_provider_ids())));
