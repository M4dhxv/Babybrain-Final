-- 00146_commercial_terms_audit.sql
--
-- Audit trail for commercial agreement changes.
--
-- `subscriptions` records only the CURRENT plan/commission_rate/fee_payer —
-- every update overwrites `updated_at` in place, so "when did this vendor's
-- terms last change" was answerable but "what was the full history of
-- changes" was not. This adds an append-only log, written by a trigger so it
-- can never drift from what `subscriptions` actually holds (no route has to
-- remember to log anything — every insert/update is captured automatically,
-- including plan changes the Stripe webhook makes and edits made by hand in
-- /admin → Commercials).
--
-- Idempotent.

create table if not exists public.commercial_terms_audit (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references public.providers (id) on delete cascade,
  changed_at timestamptz not null default now(),
  -- The full commercial state AFTER the change, not just the delta — so a
  -- single row always answers "what were this vendor's terms as of this
  -- timestamp" without needing to replay history from the beginning.
  plan text,
  commission_rate numeric(4,3),
  commission_flat_cents integer,
  fee_payer text,
  commission_on_packages boolean,
  custom_terms boolean,
  -- 'signup' = the subscriptions row was first created (INSERT);
  -- 'change'  = an existing row's commercial terms changed (UPDATE).
  -- Not finer-grained than that: the trigger can't see whether an UPDATE was
  -- an admin editing /admin → Commercials or the Stripe webhook applying a
  -- plan change — both write the same columns the same way.
  event text not null check (event in ('signup', 'change'))
);

comment on table public.commercial_terms_audit is
  'Append-only history of subscriptions.plan/commission_rate/fee_payer/commission_on_packages/custom_terms, one row per actual change. Written only by the trigger below.';

create index if not exists commercial_terms_audit_provider_idx
  on public.commercial_terms_audit (provider_id, changed_at desc);

alter table public.commercial_terms_audit enable row level security;
-- No policies: service-role only, same as provider_earnings — the admin API
-- routes and the Stripe webhook are the only things that need to read this.

create or replace function public.log_commercial_terms_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE'
    and new.plan is not distinct from old.plan
    and new.commission_rate is not distinct from old.commission_rate
    and new.commission_flat_cents is not distinct from old.commission_flat_cents
    and new.fee_payer is not distinct from old.fee_payer
    and new.commission_on_packages is not distinct from old.commission_on_packages
    and new.custom_terms is not distinct from old.custom_terms
  then
    return new;  -- none of the commercial columns actually changed — e.g. stripe_customer_id got set
  end if;

  insert into public.commercial_terms_audit (
    provider_id, plan, commission_rate, commission_flat_cents,
    fee_payer, commission_on_packages, custom_terms, event
  ) values (
    new.provider_id, new.plan, new.commission_rate, new.commission_flat_cents,
    new.fee_payer, new.commission_on_packages, new.custom_terms,
    case when tg_op = 'INSERT' then 'signup' else 'change' end
  );
  return new;
end;
$$;

-- AFTER, not BEFORE: 00052's subscriptions_sync_commission trigger runs
-- BEFORE and can rewrite commission_rate on the way in — this has to see the
-- row that actually got written, not the pre-sync value the caller sent.
drop trigger if exists commercial_terms_audit_trigger on public.subscriptions;
create trigger commercial_terms_audit_trigger
  after insert or update on public.subscriptions
  for each row execute function public.log_commercial_terms_change();

-- Seed one row per existing provider so history starts somewhere instead of
-- silently beginning at whenever this migration happens to run.
insert into public.commercial_terms_audit (provider_id, plan, commission_rate, commission_flat_cents, fee_payer, commission_on_packages, custom_terms, event)
select provider_id, plan, commission_rate, commission_flat_cents, fee_payer, commission_on_packages, custom_terms, 'signup'
from public.subscriptions
where not exists (
  select 1 from public.commercial_terms_audit a where a.provider_id = subscriptions.provider_id
);
