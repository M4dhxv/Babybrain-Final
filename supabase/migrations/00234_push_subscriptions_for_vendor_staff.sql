-- 00234_push_subscriptions_for_vendor_staff.sql
--
-- Web Push for the vendor portal.
--
-- push_subscriptions.user_id referenced parent_profiles(id) (00168), but only
-- some vendor staff have a parent profile (18 of 41 active staff users did not
-- when this was written), so saving a subscription would fail for them with a
-- foreign-key violation. A subscription belongs to a signed-in user, whatever
-- their role, so it now references auth.users(id) instead. Cascade on delete is
-- kept: deleting the account removes its devices.
--
-- Nothing else changes: the RLS policy and the save/delete functions all key on
-- auth.uid() and are unaffected.
--
-- Idempotent.

begin;

alter table public.push_subscriptions
  drop constraint if exists push_subscriptions_user_id_fkey;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.push_subscriptions'::regclass
      and conname = 'push_subscriptions_user_id_auth_fkey'
  ) then
    alter table public.push_subscriptions
      add constraint push_subscriptions_user_id_auth_fkey
      foreign key (user_id) references auth.users (id) on delete cascade;
  end if;
end $$;

notify pgrst, 'reload schema';

commit;
