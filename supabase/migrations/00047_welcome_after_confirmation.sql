-- QA 17/08/26: "Welcome to BabyBrain e-mail comes before confirmed e-mail —
-- you should have to confirm your e-mail before you are welcomed, as
-- technically no account under that e-mail is confirmed."
--
-- `handle_new_user()` fires on INSERT into auth.users, which happens the moment
-- the sign-up form is submitted — before the address has been verified. It
-- inserted the 'welcome' notification unconditionally, and the notifications
-- webhook turns that row into the welcome email. So the welcome raced ahead of
-- the confirmation email and greeted an address nobody had proved they own.
--
-- The welcome now only goes out once `email_confirmed_at` is set:
--   · accounts created already-confirmed (admin API, invite flows) still get it
--     immediately, from handle_new_user as before;
--   · everyone else gets it from on_auth_user_email_confirmed, which already
--     exists and already fires on the null -> not-null transition.
--
-- Both paths guard on there being no 'welcome' row yet, so a user who somehow
-- passes through both is welcomed once rather than twice.

begin;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.parent_profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'full_name', ''))
  on conflict (id) do nothing;

  insert into public.user_preferences (user_id) values (new.id)
  on conflict (user_id) do nothing;

  -- Only welcome a confirmed address. Unconfirmed sign-ups are welcomed later,
  -- by the confirmation trigger below.
  if new.email_confirmed_at is not null
     and not exists (
       select 1 from public.notifications
       where user_id = new.id and type = 'welcome'
     ) then
    insert into public.notifications (user_id, type, title, body, data)
    values (new.id, 'welcome', 'Welcome to BabyBrain!',
      'Tell us about your child to get personalised activity recommendations.',
      '{"url": "/onboarding"}');
  end if;

  -- Persist whatever the sign-up form collected, session or not. A malformed
  -- payload must never block account creation, so failures are swallowed —
  -- the parent can still fill the gaps in from their profile.
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

-- Belt and braces: replay the payload when the email is confirmed, in case the
-- profile rows were not in place when the user row was first inserted. Now also
-- the point at which an ordinary sign-up is welcomed.
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
    -- pre-confirmed account already welcomed at insert isn't welcomed twice.
    if not exists (
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

commit;
