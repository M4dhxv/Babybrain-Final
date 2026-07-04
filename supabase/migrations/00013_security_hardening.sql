-- BabyBrain — Security hardening
-- Closes four issues found in review:
--   1. Payment bypass: parents could self-insert a "paid" booking.
--   2. Reviews required no proof of attendance.
--   3. listing_events could be spoofed for any provider by anyone.
--   4. Staff invites auto-consumed before the email was verified.
-- Idempotent.

-- =============================================================
-- 1. Bookings — parents may create a booking, but never set the
--    payment/settlement columns. Those are owned exclusively by the
--    Stripe webhook (service role). A BEFORE INSERT trigger hard-resets
--    them for any non-service-role caller, so the RLS insert policy
--    ("parent creates own booking", user_id = auth.uid()) can stay while
--    the money-carrying columns become server-only.
-- =============================================================
create or replace function public.enforce_booking_insert_defaults()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  -- Only the server (service role: Stripe webhook / trusted route) may set
  -- payment state or amount. Everyone else gets safe defaults regardless of
  -- what they submitted.
  if coalesce(auth.role(), '') <> 'service_role' then
    new.payment_status := 'none';
    new.amount := null;
    new.stripe_payment_intent := null;
    new.waitlist_position := null;
    if new.status is null or new.status not in ('pending', 'waitlisted') then
      new.status := 'pending';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists booking_insert_defaults on public.bookings;
create trigger booking_insert_defaults
  before insert on public.bookings
  for each row execute function public.enforce_booking_insert_defaults();

-- =============================================================
-- 2. Reviews — a parent may only review an activity they actually
--    booked (confirmed or completed booking on one of its sessions).
-- =============================================================
drop policy if exists "insert own review" on public.reviews;
create policy "insert own review" on public.reviews
  for insert with check (
    user_id = auth.uid()
    and exists (
      select 1
      from public.bookings b
      join public.activity_sessions s on s.id = b.session_id
      where b.user_id = auth.uid()
        and s.activity_id = reviews.activity_id
        and b.status in ('confirmed', 'completed')
    )
  );

-- =============================================================
-- 3. listing_events — append-only analytics. Lock down inserts so a
--    caller can only log an event attributed to themselves and cannot
--    mislabel it against an unrelated provider/activity.
--      * viewer_id must be the caller (or null for a genuinely anon view)
--      * if activity_id is given, it must belong to provider_id
-- =============================================================
drop policy if exists "anyone logs a view" on public.listing_events;
drop policy if exists "callers log their own view" on public.listing_events;
create policy "callers log their own view" on public.listing_events
  for insert with check (
    type in ('profile_view', 'listing_view', 'booking_click')
    and (viewer_id is null or viewer_id = auth.uid())
    and (
      activity_id is null
      or exists (
        select 1 from public.activities a
        where a.id = activity_id
          and a.provider_id = listing_events.provider_id
      )
    )
  );

-- =============================================================
-- 4. Staff invites — only consume a pending invite once the new user's
--    email is verified, and also consume on the later confirmation event.
--    Prevents an attacker who signs up with a known invited email (when
--    email confirmation is enabled) from inheriting a staff/manager role
--    on an unverified account.
--    NOTE: this closes the window only when Supabase email confirmation is
--    ENABLED. Keep "Confirm email" on in Auth settings — with it off, any
--    signup email is unverified by definition and this cannot be enforced
--    in the database.
-- =============================================================
create or replace function public.consume_provider_invites(p_user_id uuid, p_email text)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.provider_members (provider_id, user_id, role, status, invited_email)
  select i.provider_id, p_user_id, i.role, 'active', i.email
  from public.provider_invites i
  where lower(i.email) = lower(p_email) and i.accepted_at is null
  on conflict (provider_id, user_id) do nothing;

  update public.provider_invites
  set accepted_at = now()
  where lower(email) = lower(p_email) and accepted_at is null;
end;
$$;

-- Signup trigger: create parent profile/preferences/welcome as before, but
-- only auto-consume invites when the email is already verified at signup
-- (e.g. confirmation disabled, or admin-created confirmed user).
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

  insert into public.notifications (user_id, type, title, body, data)
  values (new.id, 'welcome', 'Welcome to BabyBrain!',
    'Tell us about your child to get personalised activity recommendations.',
    '{"url": "/onboarding"}');

  if new.email_confirmed_at is not null then
    perform public.consume_provider_invites(new.id, new.email);
  end if;

  return new;
end;
$$;

-- Confirmation trigger: consume invites when the email flips to verified.
create or replace function public.handle_user_email_confirmed()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if new.email_confirmed_at is not null
     and old.email_confirmed_at is distinct from new.email_confirmed_at then
    perform public.consume_provider_invites(new.id, new.email);
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_email_confirmed on auth.users;
create trigger on_auth_user_email_confirmed
  after update on auth.users
  for each row execute function public.handle_user_email_confirmed();
