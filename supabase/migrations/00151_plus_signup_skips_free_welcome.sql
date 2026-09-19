-- A parent who picks Plus on the sign-up form is welcomed by the Plus welcome
-- (parent_welcome_paid) once their payment lands, not by the Free welcome the
-- moment they confirm their email.
--
-- The form now stores the chosen plan on the account as auth metadata
-- (`intended_plan = 'plus'`) so it survives the email-confirmation round trip
-- (the bug this fixes: a parent who chose Plus but had to confirm by email was
-- created on Free, never sent to payment, and got the Free welcome). Until
-- they pay they are on Free, so the Free welcome would be the wrong email;
-- the webhook clears the intent and sends the Plus welcome on payment
-- (lib/signup-plan.ts).
--
-- Same two functions as 00047, each with one extra condition on the welcome
-- insert. Accounts with no `intended_plan` behave exactly as before.
--
-- Trade-off: a parent who chose Plus and then never pays receives no welcome
-- email at all. They still get the confirmation email, and the app keeps
-- offering to finish payment ("Not now" clears the intent).

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
    if coalesce(new.raw_user_meta_data ->> 'intended_plan', '') <> 'plus'
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

notify pgrst, 'reload schema';

commit;
