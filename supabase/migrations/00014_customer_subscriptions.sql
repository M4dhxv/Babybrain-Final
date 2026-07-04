-- BabyBrain — Customer (parent) subscriptions: the "Plus" plan.
-- One row per parent. Written only by the Stripe webhook / checkout route
-- (service role); parents may read their own row. Idempotent.

create table if not exists public.customer_subscriptions (
  user_id uuid primary key references public.parent_profiles (id) on delete cascade,
  plan text not null default 'free' check (plan in ('free', 'plus')),
  billing_interval text check (billing_interval in ('monthly', 'annual')),
  stripe_customer_id text,
  stripe_subscription_id text,
  status text not null default 'active'
    check (status in ('active', 'trialing', 'past_due', 'canceled', 'incomplete')),
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.customer_subscriptions enable row level security;

-- Parents may read their own subscription; all writes go through the service
-- role (Stripe webhook + checkout route), which bypasses RLS.
drop policy if exists "read own customer subscription" on public.customer_subscriptions;
create policy "read own customer subscription" on public.customer_subscriptions
  for select using (user_id = auth.uid());
