-- 00174_vendor_users_skip_confirm_welcome.sql
--
-- 00165 taught handle_new_user() to skip the parent bootstrap for
-- account_kind = 'vendor' users, but its sibling handle_user_email_confirmed()
-- was never told. When the Auth admin API creates a pre-confirmed vendor
-- user (staff invite, business claim), the confirm step fires this trigger,
-- which inserts a parent 'welcome' notification. notifications.user_id
-- references parent_profiles(id), and a vendor user has no parent_profiles
-- row — so the insert fails the FK, and Auth aborts the whole createUser with
-- "Database error creating new user" (500 unexpected_failure).
--
-- Net effect since 00165: every staff invite to an address with no BabyBrain
-- login failed with "Could not create the invitee's login". Reproduced on
-- 24 Sep 2026 (Physio Down Under inviting info@physiodownunder.sg).
--
-- Fix: skip the welcome for vendor users, exactly as handle_new_user() does.
-- consume_provider_invites() still runs — that part IS for vendor users.
--
-- Idempotent.

create or replace function public.handle_user_email_confirmed()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if new.email_confirmed_at is not null
     and old.email_confirmed_at is distinct from new.email_confirmed_at then
    perform public.consume_provider_invites(new.id, new.email);
    if new.raw_user_meta_data ? 'onboarding' then
      begin
        perform public.apply_signup_payload(new.id, new.raw_user_meta_data -> 'onboarding');
      exception when others then
        raise warning 'apply_signup_payload failed for %: %', new.id, sqlerrm;
      end;
    end if;

    -- The welcome the sign-up deliberately held back. Guarded so a
    -- pre-confirmed account already welcomed at insert isn't welcomed twice,
    -- and never for a vendor-side user (no parent_profiles row to hang it on).
    if coalesce(new.raw_user_meta_data ->> 'account_kind', '') <> 'vendor'
       and coalesce(new.raw_user_meta_data ->> 'intended_plan', '') <> 'plus'
       and not exists (
      select 1 from public.notifications
      where user_id = new.id and type = 'welcome'
    ) then
      insert into public.notifications (user_id, type, title, body, data)
      values (new.id, 'welcome', 'Welcome to BabyBrain!',
        'Tell us about your child to get personalised activity recommendations.',
        '{"url": "/onboarding"}');
    end if;
  end if;
  return new;
end;
$$;
