-- 00113_one_active_owner_per_provider.sql
--
-- Defense-in-depth for the "Claim Your Business" ownership bug.
--
-- The claim/verify route granted `provider_members.role = 'owner'` to whatever
-- session rode along on the request instead of to the account that proved
-- control of the claim's contact email. A vendor signed in as account A who
-- claimed a different business with email B ended up as owner of B on account
-- A, and `providers.owner_id` was overwritten to match.
--
-- The route is fixed to bind ownership to the verified email. This migration is
-- the layer under it: the database itself now refuses to hold two active owners
-- for one provider, so no future route bug (or manual mistake) can re-create
-- the corrupt shape. It also cleans up any provider that already has more than
-- one active owner.
--
-- NOTE: a provider having exactly one owner that is the "wrong" account (the
-- bug's usual outcome, since the claimed business had no prior owner) is not a
-- constraint violation and is not touched here — use
-- scripts/_audit-claim-ownership.mjs to find and undo those.

begin;

-- =============================================================
-- 1. Collapse any existing multi-owner providers
-- =============================================================
-- Keep the earliest active owner; demote the rest to 'manager' (they keep
-- access, they just stop being a second owner). Logged so an operator can see
-- what moved.
do $$
declare
  r record;
begin
  for r in
    select provider_id, count(*) as owners
    from public.provider_members
    where role = 'owner' and status = 'active'
    group by provider_id
    having count(*) > 1
  loop
    raise notice '00113: provider % had % active owners — demoting all but the earliest', r.provider_id, r.owners;
  end loop;

  update public.provider_members m
  set role = 'manager'
  where m.role = 'owner'
    and m.status = 'active'
    and m.id <> (
      select m2.id
      from public.provider_members m2
      where m2.provider_id = m.provider_id
        and m2.role = 'owner'
        and m2.status = 'active'
      order by m2.created_at asc, m2.id asc
      limit 1
    );
end $$;

-- =============================================================
-- 2. Enforce a single active owner per provider
-- =============================================================
create unique index if not exists provider_members_one_active_owner
  on public.provider_members (provider_id)
  where role = 'owner' and status = 'active';

-- =============================================================
-- 3. Friendly error instead of a raw 23505 on the index
-- =============================================================
create or replace function public.provider_members_guard_single_owner()
returns trigger
language plpgsql
as $$
begin
  if new.role = 'owner' and new.status = 'active' then
    if exists (
      select 1 from public.provider_members
      where provider_id = new.provider_id
        and role = 'owner'
        and status = 'active'
        and user_id <> new.user_id
    ) then
      raise exception
        'provider % already has an active owner', new.provider_id
        using errcode = 'unique_violation';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists provider_members_single_owner on public.provider_members;
create trigger provider_members_single_owner
  before insert or update on public.provider_members
  for each row execute function public.provider_members_guard_single_owner();

commit;
