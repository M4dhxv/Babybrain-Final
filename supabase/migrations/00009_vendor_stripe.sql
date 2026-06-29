-- BabyBrain Phase 2 — Stripe Connect fields on providers
-- (subscription fields already live on public.subscriptions)
-- Idempotent.

alter table public.providers
  add column if not exists stripe_account_id text,        -- Connect (Express) account
  add column if not exists payouts_enabled boolean not null default false;

-- App-config keys for the Stripe webhook + checkout (read server-side).
-- Populate via service role after setting Stripe up:
--   insert into public.app_config(key,value) values
--     ('stripe_growth_price_id','price_...'),
--     ('stripe_boost_amount_cents','3000')
--   on conflict (key) do update set value = excluded.value;
