-- 00207_parent_is_test_flag.sql
--
-- Let the founder mark a parent account as a test account from /admin → Parents.
--
-- Until now an account counted as "test" only if its email looked like a test
-- address or it belonged to a vendor login (lib/admin-test-data.ts). That can't
-- catch a QA signup made with a normal-looking email, so this adds an explicit
-- flag the admin can set. Test parents are left out of the admin Parents list
-- by default. Nothing is deleted.
--
-- Idempotent.

alter table public.parent_profiles
  add column if not exists is_test boolean not null default false;

comment on column public.parent_profiles.is_test is
  'Marked as a test/QA account by an admin (/admin → Parents). Hidden from the admin Parents list unless test accounts are included.';

-- Parents can update their own profile row (RLS "update own profile"), so keep
-- them from flipping this flag themselves. Only the service role (the admin
-- API) and direct database access may change it.
create or replace function public.protect_parent_is_test()
returns trigger
language plpgsql
as $$
begin
  if new.is_test is distinct from old.is_test
     and coalesce(auth.role(), '') in ('authenticated', 'anon') then
    new.is_test := old.is_test;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_parent_is_test on public.parent_profiles;
create trigger protect_parent_is_test
  before update on public.parent_profiles
  for each row execute function public.protect_parent_is_test();
