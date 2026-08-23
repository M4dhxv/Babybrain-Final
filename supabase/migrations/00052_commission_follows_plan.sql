-- 00052_commission_follows_plan.sql
--
-- 00051 backfilled every existing vendor's commission rate to match their
-- plan, but `subscriptions.commission_rate` still defaults to 0.150 and
-- nothing keeps it in step afterwards. Validation caught the consequence: a
-- vendor created *after* that migration lands on 15% again, and a vendor who
-- upgrades Growth → Pro keeps paying 15% against an advertised 10%.
--
-- So make the rate follow the plan by default, while leaving room for a
-- negotiated rate that plan changes must not overwrite.
--
-- Idempotent.

-- Marks a vendor whose terms were set by hand in /admin. Once true, the plan
-- no longer drives their rate — that's what makes a bespoke deal stick.
alter table public.subscriptions
  add column if not exists custom_terms boolean not null default false;

comment on column public.subscriptions.custom_terms is
  'True when commission terms were negotiated in /admin. Plan changes stop overwriting the rate.';

-- The published pricing deck, in one place. 'free' covers both the
-- listing-only tier (which cannot take bookings, so the rate is academic) and
-- Pay As You Go, advertised at 10%.
create or replace function public.plan_commission_rate(p_plan text)
returns numeric language sql immutable as $$
  select case p_plan
    when 'growth' then 0.150
    when 'pro'    then 0.100
    else 0.100
  end;
$$;

-- Keep the rate in step with the plan on insert, and whenever the plan moves.
create or replace function public.sync_commission_rate()
returns trigger language plpgsql as $$
begin
  if new.custom_terms then
    return new;                       -- a negotiated deal wins over the plan
  end if;
  if tg_op = 'INSERT' or new.plan is distinct from old.plan then
    new.commission_rate := public.plan_commission_rate(new.plan);
  end if;
  return new;
end;
$$;

drop trigger if exists subscriptions_sync_commission on public.subscriptions;
create trigger subscriptions_sync_commission
  before insert or update of plan on public.subscriptions
  for each row execute function public.sync_commission_rate();

-- Re-run the alignment now that the rule exists, for anything 00051 missed
-- (rows created between the two migrations).
update public.subscriptions
  set commission_rate = public.plan_commission_rate(plan)
  where not custom_terms
    and commission_rate is distinct from public.plan_commission_rate(plan);
