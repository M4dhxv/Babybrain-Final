-- 00064_fix_plan_commission_rate.sql
--
-- plan_commission_rate() still had the pre-rename commission percentages
-- (growth=15%, pro/else=10%) from before the vendor Plans page was renamed
-- to Pay As You Grow / Pro / Premium (see PLAN_META in
-- frontends/vendor/src/lib/plans.ts). The subscriptions_sync_commission
-- trigger calls this function on every INSERT and plan change, silently
-- overwriting commission_rate — so any new Pro/Premium signup would have
-- been charged the old rates rather than what the pricing page promises.
create or replace function public.plan_commission_rate(p_plan text)
returns numeric
language sql
immutable
as $function$
  select case p_plan
    when 'growth'  then 0.100  -- displays as "Pro" — SGD 99/month, 10%
    when 'pro'     then 0.080  -- displays as "Premium" — SGD 199/month, 8%
    when 'premium' then 0.080  -- legacy alias for the same top tier as 'pro'
    else                0.120  -- 'free' — "Pay As You Grow", 12%
  end;
$function$;

-- Backfill existing rows to match — the trigger only fires on INSERT or a
-- plan change, so rows already sitting on their current plan would
-- otherwise keep the stale rate indefinitely. Negotiated deals (custom_terms)
-- are left untouched, same as the trigger itself already respects.
update public.subscriptions
set commission_rate = public.plan_commission_rate(plan)
where not custom_terms;
