-- 00039_vendor_pro_plan.sql
--
-- Wires the vendor "Pro" tier into the subscriptions table.
--
-- QA: "click upgrade to growth and then start growing and it just takes me
-- back to the dashboard still on the free plan." The proximate bug was in the
-- frontend (Plans sent every upgrade click to /login, which bounces an
-- already-signed-in session straight to /dashboard) — but chasing it turned
-- up a second, more serious problem: `subscriptions.plan` has a CHECK
-- constraint of `ANY ('free', 'growth')`. The vendor frontend's own
-- SubscriptionPlan type has always included 'pro' and 'premium', and the
-- checkout route now accepts plan: 'pro' — but completing a real Pro
-- subscription would have hit this constraint and failed to record, silently
-- leaving a paying vendor stuck on 'free' in the database while Stripe
-- believed they were subscribed.
alter table public.subscriptions drop constraint if exists subscriptions_plan_check;
alter table public.subscriptions add constraint subscriptions_plan_check
  check (plan = any (array['free', 'growth', 'pro']));

-- Not adding 'premium' here: it exists in the frontend's PLAN_META as a
-- possible future tier but has no price, no checkout route, and isn't part of
-- the founder's current four-tier deck (Free / Pay As You Go / Growth / Pro).
-- Widen this again if that changes.
