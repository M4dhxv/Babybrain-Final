-- 00212_admin_test_overrides.sql
--
-- Two more ways for an admin to correct what counts as test data, without deleting anything.
--
-- 1. parent_profiles.is_real_override: "this is a real parent". The admin portal decides
--    automatically which accounts are test (test-looking emails, logins that only work for test
--    vendors). That is sometimes wrong, so an admin can now force an account to count as real.
--    Together with the existing is_test (force test) this gives three states per account:
--    automatic (both false), forced test (is_test), forced real (is_real_override).
--
-- 2. provider_earnings.is_test: flag a single payment as test, so one internal purchase made
--    on a real vendor can be left out of revenue without hiding the vendor or the parent.
--
-- Both default to false, so nothing changes until an admin uses them. Idempotent.

begin;

alter table public.parent_profiles
  add column if not exists is_real_override boolean not null default false;

comment on column public.parent_profiles.is_real_override is
  'Admin forced this account to count as a real parent, skipping the automatic test rules (/admin → Parents).';

alter table public.provider_earnings
  add column if not exists is_test boolean not null default false;

comment on column public.provider_earnings.is_test is
  'Admin flagged this single payment as test: left out of admin Metrics, Payments and Parents spend (/admin → Payments).';

-- Parents can update their own profile row (RLS "update own profile"), so keep them from flipping
-- either admin flag themselves. Replaces the function from 00207 to cover the new column too.
create or replace function public.protect_parent_is_test()
returns trigger
language plpgsql
as $$
begin
  if coalesce(auth.role(), '') in ('authenticated', 'anon') then
    if new.is_test is distinct from old.is_test then
      new.is_test := old.is_test;
    end if;
    if new.is_real_override is distinct from old.is_real_override then
      new.is_real_override := old.is_real_override;
    end if;
  end if;
  return new;
end;
$$;

commit;
