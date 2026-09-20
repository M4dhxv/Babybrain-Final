-- 00158_boost_purchases_idempotency.sql
--
-- Bug audit (2026-09-20): the Boost branch in the Stripe webhook has no
-- idempotency guard, unlike the booking/package branches which dedupe on
-- stripe_payment_intent. Stripe redelivering checkout.session.completed for
-- the same successful Boost purchase (a documented Stripe behavior — retries
-- after a slow response, or both `completed` and `async_payment_succeeded`
-- firing for one payment) recomputed `boosted_until = now() + days` from
-- scratch on every delivery, pushing the promotion further out than what was
-- actually paid for.
--
-- A small ledger table, same shape/purpose as provider_earnings: the unique
-- index on stripe_payment_intent is what makes the fix idempotent, and it
-- gives Boost purchases an audit trail that didn't exist before either.
--
-- Idempotent.

create table if not exists public.boost_purchases (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null references public.activities (id) on delete cascade,
  days integer not null,
  stripe_payment_intent text,
  created_at timestamptz not null default now()
);

comment on table public.boost_purchases is
  'One row per applied Boost purchase, keyed by stripe_payment_intent so a redelivered webhook event cannot extend boosted_until twice. Written only by the Stripe webhook.';

create unique index if not exists boost_purchases_payment_intent_key
  on public.boost_purchases (stripe_payment_intent)
  where stripe_payment_intent is not null;

create index if not exists boost_purchases_activity_idx
  on public.boost_purchases (activity_id, created_at desc);
