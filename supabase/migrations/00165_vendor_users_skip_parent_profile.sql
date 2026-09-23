-- 00165_vendor_users_skip_parent_profile.sql
--
-- Vendor-side auth users (business claim, staff invites) were silently
-- getting a parent_profiles row too: handle_new_user() fires on every
-- auth.users insert with no idea which app or flow created it. The vendor
-- API routes now tag those inserts with raw_user_meta_data.account_kind =
-- 'vendor' (see app/api/vendor/claim/verify/route.ts and
-- app/api/vendor/staff/invite/route.ts); this migration teaches the trigger
-- to skip the parent bootstrap (profile + preferences + welcome
-- notification) for them.
--
-- Existing mis-tagged parent_profiles rows are left as-is (not deleted —
-- they're FK-referenced by bookings/subscriptions/etc, and deleting is not
-- reversible). The admin Metrics query excludes them by joining against
-- provider_members instead (see app/api/admin/metrics/route.ts).
--
-- Idempotent.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if (new.raw_user_meta_data ->> 'account_kind') = 'vendor' then
    return new;
  end if;

  insert into public.parent_profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', '')
  )
  on conflict (id) do nothing;

  insert into public.user_preferences (user_id) values (new.id)
  on conflict (user_id) do nothing;

  insert into public.notifications (user_id, type, title, body, data)
  values (
    new.id, 'welcome', 'Welcome to BabyBrain!',
    'Tell us about your child to get personalised activity recommendations.',
    '{"url": "/onboarding"}'
  );

  return new;
end;
$$;
