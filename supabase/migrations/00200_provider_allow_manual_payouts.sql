-- 00200_provider_allow_manual_payouts.sql
--
-- "Publish anyway" on the /admin vendor forms was a one-shot tick-box: it let
-- that one save publish a class for a vendor with no Stripe payouts, and was
-- then forgotten. The vendor's own portal has a separate gate
-- (ActivitiesPage: "Set up payouts before publishing") that never saw it, so
-- an admin could tick the box and the vendor still couldn't publish.
--
-- This stores the decision on the vendor. When true, BabyBrain settles that
-- vendor's paid bookings manually (checkout already falls back to that when a
-- provider has no live Stripe account), and BOTH gates — the admin save and the
-- vendor portal — let them publish.
--
-- Who may set it: only BabyBrain admins. The admin API uses the service role
-- (no auth.uid()); a vendor signed in on the portal can update their own
-- provider row directly (RLS "managers update provider" is row-scoped only),
-- so without a guard they could switch this on for themselves. The trigger
-- below refuses any change from a signed-in session. Same pattern as
-- 00114 (ownership columns), kept as its own trigger so that migration's
-- behaviour is untouched.
--
-- Idempotent.

begin;

alter table public.providers
  add column if not exists allow_manual_payouts boolean not null default false;

comment on column public.providers.allow_manual_payouts is
  'Admin-set. When true the vendor may publish BabyBrain-checkout classes without Stripe payouts; BabyBrain settles their paid bookings manually until they connect Stripe. Only changeable by the service role (see providers_guard_manual_payouts).';

create or replace function public.providers_guard_manual_payouts()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Service role / SQL console / SECURITY DEFINER server code has no
  -- auth.uid(): that is the admin API and migrations, and is trusted.
  if auth.uid() is null then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if coalesce(new.allow_manual_payouts, false) then
      raise exception 'only BabyBrain admins may set allow_manual_payouts'
        using errcode = 'insufficient_privilege';
    end if;
  elsif new.allow_manual_payouts is distinct from old.allow_manual_payouts then
    raise exception 'only BabyBrain admins may change allow_manual_payouts on provider %', old.id
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

drop trigger if exists providers_guard_manual_payouts on public.providers;
create trigger providers_guard_manual_payouts
  before insert or update on public.providers
  for each row execute function public.providers_guard_manual_payouts();

notify pgrst, 'reload schema';

commit;
