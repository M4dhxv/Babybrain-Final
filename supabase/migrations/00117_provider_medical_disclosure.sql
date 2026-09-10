-- 00117_provider_medical_disclosure.sql
--
-- "Require medical disclosure" used to be a per-activity switch buried in the
-- activity create/edit form (activities.requires_medical_disclosure), with no
-- way to say "every class" or "just these three" in one place.
--
-- The vendor portal now has a single control under
-- Activities -> Policy & consent management: a master toggle plus an
-- "all activities / certain activities" scope. That choice is stored here, on
-- the provider, and a pair of triggers keep the existing
-- activities.requires_medical_disclosure column -- which the parent booking
-- form and every Wix checkout path already read -- in sync. Nothing downstream
-- changes, and a newly-created class picks up an "all" rule automatically.
--
-- Idempotent.

begin;

alter table public.providers
  add column if not exists medical_disclosure_mode text not null default 'off',
  add column if not exists medical_disclosure_activity_ids uuid[] not null default '{}';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'providers_medical_disclosure_mode_check'
  ) then
    alter table public.providers
      add constraint providers_medical_disclosure_mode_check
      check (medical_disclosure_mode in ('off', 'all', 'some'));
  end if;
end $$;

comment on column public.providers.medical_disclosure_mode is
  'Vendor-set scope for the pre-booking health declaration: off | all classes | some classes '
  '(listed in medical_disclosure_activity_ids). Mirrored onto '
  'activities.requires_medical_disclosure by trigger.';

-- =============================================================
-- Keep activities.requires_medical_disclosure in step with the rule
-- =============================================================

-- Rule changed -> recompute the flag across the provider's classes.
create or replace function public.sync_activity_medical_disclosure()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.medical_disclosure_mode is distinct from old.medical_disclosure_mode
     or new.medical_disclosure_activity_ids is distinct from old.medical_disclosure_activity_ids
  then
    update public.activities a
    set requires_medical_disclosure = (
      new.medical_disclosure_mode = 'all'
      or (new.medical_disclosure_mode = 'some' and a.id = any (new.medical_disclosure_activity_ids))
    )
    where a.provider_id = new.id
      and a.requires_medical_disclosure is distinct from (
        new.medical_disclosure_mode = 'all'
        or (new.medical_disclosure_mode = 'some' and a.id = any (new.medical_disclosure_activity_ids))
      );
  end if;
  return new;
end $$;

drop trigger if exists providers_sync_medical_disclosure on public.providers;
create trigger providers_sync_medical_disclosure
  after update of medical_disclosure_mode, medical_disclosure_activity_ids
  on public.providers
  for each row execute function public.sync_activity_medical_disclosure();

-- A new class inherits an "all" rule. A "some" rule can't name it yet, so it
-- stays as inserted. Only ever turns the flag ON -- an explicit `true` from an
-- importer / the admin panel is left alone.
create or replace function public.apply_provider_medical_disclosure()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mode text;
  v_ids uuid[];
begin
  select medical_disclosure_mode, medical_disclosure_activity_ids
    into v_mode, v_ids
  from public.providers
  where id = new.provider_id;

  if v_mode = 'all'
     or (v_mode = 'some' and new.id = any (v_ids))
  then
    new.requires_medical_disclosure := true;
  end if;
  return new;
end $$;

drop trigger if exists activities_apply_medical_disclosure on public.activities;
create trigger activities_apply_medical_disclosure
  before insert on public.activities
  for each row execute function public.apply_provider_medical_disclosure();

-- =============================================================
-- Seed the rule from whatever the per-activity flags say today
-- =============================================================
with agg as (
  select
    p.id as provider_id,
    count(a.id) as total,
    count(a.id) filter (where coalesce(a.requires_medical_disclosure, false)) as on_count,
    coalesce(
      array_agg(a.id) filter (where coalesce(a.requires_medical_disclosure, false)),
      '{}'
    ) as flagged_ids
  from public.providers p
  left join public.activities a on a.provider_id = p.id
  group by p.id
),
seed as (
  select
    provider_id,
    case when on_count = 0 then 'off'
         when on_count = total then 'all'
         else 'some' end as mode,
    flagged_ids
  from agg
)
update public.providers p
set
  medical_disclosure_mode = seed.mode,
  -- Only the "some" case needs the explicit list; "off" / "all" ignore it.
  medical_disclosure_activity_ids = case when seed.mode = 'some' then seed.flagged_ids else '{}' end
from seed
where seed.provider_id = p.id;

commit;
