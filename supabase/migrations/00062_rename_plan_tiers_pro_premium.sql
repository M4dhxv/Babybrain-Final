-- 00062_rename_plan_tiers_pro_premium.sql
--
-- Vendor Plans page rename: the tier previously called "Growth" is now
-- displayed as "Pro" (SGD 99/month, 10% commission), and the tier previously
-- called "Pro" is now displayed as "Premium" (SGD 199/month, 8% commission).
-- The underlying enum identifiers stay as `growth`/`pro` (no Stripe price-id
-- config changes needed) — `pro` now means what `growth` used to mean, and
-- `premium` takes over what `pro` used to mean. See frontends/vendor's
-- lib/plans.ts PLAN_META for the frontend side of this mapping.
--
-- `premium` was never added to subscriptions_plan_check (00039 explicitly
-- left it out — no price, no checkout route at the time). It has one now, so
-- widen the constraint the same way 00039 widened it for `pro`.
alter table public.subscriptions drop constraint if exists subscriptions_plan_check;
alter table public.subscriptions add constraint subscriptions_plan_check
  check (plan = any (array['free', 'growth', 'pro', 'premium']));

-- Relabel existing subscriptions in one atomic pass — the CASE evaluates
-- against each row's original `plan` value, so a `growth` row that becomes
-- `pro` here is never re-matched by the `pro` branch in the same statement.
update public.subscriptions
set
  plan = case plan
    when 'growth' then 'pro'
    when 'pro' then 'premium'
    else plan
  end,
  commission_rate = case plan
    when 'growth' then 0.10
    when 'pro' then 0.08
    else commission_rate
  end
where plan in ('growth', 'pro');
