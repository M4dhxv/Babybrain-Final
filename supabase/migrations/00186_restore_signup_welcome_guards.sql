-- 00186_restore_signup_welcome_guards.sql
--
-- 00165 (vendor users skip the parent profile) rebuilt handle_new_user() from
-- an old copy and silently dropped everything 00047 and 00151 had added:
--
--   * the welcome email waited for a CONFIRMED address -> every sign-up was
--     welcomed instantly, before confirming;
--   * Plus sign-ups skip the Free welcome -> they got the Free AND the Plus one;
--   * the "already welcomed" guard;
--   * applying the sign-up payload (children, preferences) and consuming staff
--     invites for accounts that arrive already confirmed (Google sign-in).
--
-- This restores the 00151 body and keeps 00165's vendor early-return.
--
-- Separately, the Plus welcome (lib/signup-plan.ts) is sent from the Stripe
-- webhook, and one checkout fires two events that can land in the same second.
-- Both passed the "not sent yet" check and both sent it (28 Sep). A partial
-- unique index now makes each welcome type physically one-per-user; the app's
-- insert already ignores its error, and the triggers below skip on conflict.
--
-- Idempotent.

-- Keep the earliest of any existing duplicates so the unique indexes can build.
delete from public.notifications n
using public.notifications keep
where n.type in ('welcome', 'parent_welcome_paid')
  and keep.type = n.type
  and keep.user_id = n.user_id
  and (keep.created_at, keep.id) < (n.created_at, n.id);

create unique index if not exists notifications_one_welcome_per_user
  on public.notifications (user_id) where type = 'welcome';
create unique index if not exists notifications_one_paid_welcome_per_user
  on public.notifications (user_id) where type = 'parent_welcome_paid';

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  -- 00165: vendor-side users (business claim, staff invite) get no parent
  -- profile, preferences or welcome.
  if (new.raw_user_meta_data ->> 'account_kind') = 'vendor' then
    return new;
  end if;

  insert into public.parent_profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'full_name', ''))
  on conflict (id) do nothing;

  insert into public.user_preferences (user_id) values (new.id)
  on conflict (user_id) do nothing;

  -- Only welcome a confirmed address. Unconfirmed sign-ups are welcomed later,
  -- by handle_user_email_confirmed(). Plus sign-ups get the paid welcome once
  -- their payment lands instead.
  if new.email_confirmed_at is not null
     and coalesce(new.raw_user_meta_data ->> 'intended_plan', '') <> 'plus' then
    insert into public.notifications (user_id, type, title, body, data)
    values (new.id, 'welcome', 'Welcome to BabyBrain!',
      'Tell us about your child to get personalised activity recommendations.',
      '{"url": "/onboarding"}')
    on conflict (user_id) where type = 'welcome' do nothing;
  end if;

  -- Persist whatever the sign-up form collected, session or not. A malformed
  -- payload must never block account creation, so failures are swallowed.
  if new.raw_user_meta_data ? 'onboarding' then
    begin
      perform public.apply_signup_payload(new.id, new.raw_user_meta_data -> 'onboarding');
    exception when others then
      raise warning 'apply_signup_payload failed for %: %', new.id, sqlerrm;
    end;
  end if;

  if new.email_confirmed_at is not null then
    perform public.consume_provider_invites(new.id, new.email);
  end if;

  return new;
end;
$$;

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

    -- The welcome the sign-up deliberately held back. Never for a vendor-side
    -- user or a Plus sign-up; the unique index makes a repeat a no-op.
    if coalesce(new.raw_user_meta_data ->> 'account_kind', '') <> 'vendor'
       and coalesce(new.raw_user_meta_data ->> 'intended_plan', '') <> 'plus' then
      insert into public.notifications (user_id, type, title, body, data)
      values (new.id, 'welcome', 'Welcome to BabyBrain!',
        'Tell us about your child to get personalised activity recommendations.',
        '{"url": "/onboarding"}')
      on conflict (user_id) where type = 'welcome' do nothing;
    end if;
  end if;
  return new;
end;
$$;
