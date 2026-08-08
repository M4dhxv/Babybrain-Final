-- 00036_qa_round_3.sql
-- Founder QA round 3 (rows dated 07–08/08/26).
--
-- 1. Rename the "Baby & Me Exercise" category to "Parent & Child Exercise".
-- 2. Make search match the provider's name and address, not just the listing
--    title/description — "Lucy Sparkles" and "the yard" returned nothing.
-- 3. Keep the whole sign-up payload when email confirmation is required, so a
--    parent's children and preferences survive the confirm round trip.
-- 4. Store contact-form messages so nothing is lost when email delivery fails.
-- 5. Reload PostgREST's schema cache — 00033/00034 landed but the API still
--    reported `avatar_seed` and `mark_own_attendance` as missing.

-- =============================================================
-- 1. Category rename
-- =============================================================
-- The slug stays `parent-baby`: it is stored in `children.interests` and
-- `user_preferences.interests`, so renaming it would orphan every saved
-- interest. Only the display name changes.
update public.activity_categories
   set name = 'Parent & Child Exercise'
 where slug = 'parent-baby';

-- =============================================================
-- 2. search_activities — match provider name and address too
-- =============================================================
-- `activities.search_tsv` is a generated column over title + description only,
-- so it can never see the provider's business name (a different table). Rather
-- than denormalise, match the provider fields with a second, computed tsvector.
-- At 148 published listings the extra scan is immaterial, and the indexed
-- `search_tsv` still short-circuits the common case.
create or replace function public.search_activities(
  p_query         text default null,
  p_category_slug text default null,
  p_age_months    int default null,
  p_date          date default null,
  p_lat           double precision default null,
  p_lng           double precision default null,
  p_radius_km     double precision default null,
  p_sort          text default 'popular',   -- 'popular' | 'rating' | 'distance'
  p_limit         int default 24,
  p_offset        int default 0
)
returns table (
  id uuid,
  slug text,
  title text,
  category_slug text,
  category_name text,
  age_min_months int,
  age_max_months int,
  price numeric,
  image_urls text[],
  latitude double precision,
  longitude double precision,
  rating_avg numeric,
  rating_count int,
  popularity int,
  next_session_at timestamptz,
  dist_km double precision,
  boosted boolean,
  provider_id uuid,
  provider_name text,
  address text,
  region text,
  duration_mins int,
  instant_book boolean
)
language sql stable
as $$
  select
    a.id, a.slug, a.title,
    c.slug, c.name,
    a.age_min_months, a.age_max_months,
    a.price, a.image_urls,
    -- Prefer the provider's coordinates so every listing of a venue-based
    -- business gets a map pin, even when the activity row has no address.
    coalesce(a.latitude,  p.latitude),
    coalesce(a.longitude, p.longitude),
    a.rating_avg, a.rating_count, a.popularity,
    nxt.starts_at,
    case when p_lat is not null and coalesce(a.latitude, p.latitude) is not null
         then public.distance_km(p_lat, p_lng, coalesce(a.latitude, p.latitude), coalesce(a.longitude, p.longitude)) end,
    (a.boosted_until is not null and a.boosted_until > now()) as boosted,
    a.provider_id,
    coalesce(p.business_name, a.provider_name),
    coalesce(a.address, p.address),
    coalesce(a.region, p.region),
    coalesce(
      round(extract(epoch from (nxt.ends_at - nxt.starts_at)) / 60)::int,
      dur.mins
    ),
    (a.external_booking_url is null) as instant_book
  from public.activities a
  join public.activity_categories c on c.id = a.category_id
  left join public.providers p on p.id = a.provider_id
  left join lateral (
    select s.starts_at, s.ends_at
    from public.activity_sessions s
    where s.activity_id = a.id and s.starts_at > now()
    order by s.starts_at
    limit 1
  ) nxt on true
  left join lateral (
    select round(extract(epoch from (s.ends_at - s.starts_at)) / 60)::int as mins
    from public.activity_sessions s
    where s.activity_id = a.id and s.ends_at is not null
    order by s.starts_at desc
    limit 1
  ) dur on true
  where a.is_published
    and (p_query is null
         or a.search_tsv @@ websearch_to_tsquery('english', p_query)
         -- Provider name, address and category, so searching a business
         -- ("Lucy Sparkles", "the yard") finds everything it runs.
         or to_tsvector('english', concat_ws(' ',
              coalesce(p.business_name, a.provider_name),
              coalesce(a.address, p.address),
              c.name
            )) @@ websearch_to_tsquery('english', p_query))
    and (p_category_slug is null or c.slug = p_category_slug)
    and (p_age_months is null
         or p_age_months between a.age_min_months and a.age_max_months)
    and (p_date is null or exists (
          select 1 from public.activity_sessions s
          where s.activity_id = a.id
            and (s.starts_at at time zone 'Asia/Singapore')::date = p_date))
    and (p_radius_km is null or p_lat is null or coalesce(a.latitude, p.latitude) is null
         or public.distance_km(p_lat, p_lng, coalesce(a.latitude, p.latitude), coalesce(a.longitude, p.longitude)) <= p_radius_km)
  order by
    -- An explicit sort wins. Instant-book and paid featured placement only
    -- break ties, otherwise picking "Nearest" returned the same order as
    -- "Most popular" — QA saw a class 30 minutes away sitting above ones
    -- within 10.
    case when p_sort = 'distance' and p_lat is not null and coalesce(a.latitude, p.latitude) is not null
         then public.distance_km(p_lat, p_lng, coalesce(a.latitude, p.latitude), coalesce(a.longitude, p.longitude))
    end asc nulls last,
    case when p_sort = 'rating' then a.rating_avg end desc nulls last,
    (a.external_booking_url is null) desc,
    (a.boosted_until is not null and a.boosted_until > now()) desc,
    a.popularity desc,
    a.created_at desc
  limit p_limit offset p_offset;
$$;

grant execute on function public.search_activities(
  text, text, int, date, double precision, double precision, double precision, text, int, int
) to anon, authenticated, service_role;

-- =============================================================
-- 3. Keep the sign-up payload across email confirmation
-- =============================================================
-- QA: "when I logged in the children hadn't been saved". The onboarding form
-- can only write `children` / `user_preferences` once a session exists, and
-- with email confirmation on there is no session at sign-up — so everything
-- typed was dropped on the floor.
--
-- The client now passes the whole draft as auth metadata; this trigger
-- materialises it under the new user's own id. Only the keys read below are
-- honoured, and every row is scoped to `new.id`, so a caller can write nothing
-- they could not already write themselves through RLS.
create or replace function public.apply_signup_payload(p_user_id uuid, p_meta jsonb)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_kid   jsonb;
  v_dob   date;
  v_kids  jsonb := p_meta -> 'children';
begin
  update public.parent_profiles
     set full_name         = coalesce(nullif(trim(p_meta ->> 'full_name'), ''), full_name),
         phone             = coalesce(nullif(trim(p_meta ->> 'phone'), ''), phone),
         postal_code       = coalesce(nullif(trim(p_meta ->> 'postal_code'), ''), postal_code),
         terms_accepted_at = coalesce(terms_accepted_at,
                                      case when p_meta ? 'terms_accepted' then now() end)
   where id = p_user_id;

  if p_meta ? 'preferences' then
    update public.user_preferences up
       set preferred_days    = coalesce(
             (select array_agg(value::text) from jsonb_array_elements_text(p_meta -> 'preferences' -> 'days')),
             up.preferred_days),
           preferred_times   = coalesce(
             (select array_agg(value::text) from jsonb_array_elements_text(p_meta -> 'preferences' -> 'times')),
             up.preferred_times),
           preferred_regions = coalesce(
             (select array_agg(value::text) from jsonb_array_elements_text(p_meta -> 'preferences' -> 'regions')),
             up.preferred_regions),
           interests         = coalesce(
             (select array_agg(value::text) from jsonb_array_elements_text(p_meta -> 'preferences' -> 'interests')),
             up.interests),
           budget_min        = coalesce((p_meta -> 'preferences' ->> 'budget_min')::numeric, up.budget_min),
           budget_max        = coalesce((p_meta -> 'preferences' ->> 'budget_max')::numeric, up.budget_max)
     where up.user_id = p_user_id;
  end if;

  -- Only seed children when the parent has none, so a replayed confirmation
  -- (or a second trigger firing) can't duplicate them.
  if jsonb_typeof(v_kids) = 'array'
     and not exists (select 1 from public.children where parent_id = p_user_id) then
    for v_kid in select * from jsonb_array_elements(v_kids)
    loop
      -- A malformed date must not abort the whole sign-up.
      begin
        v_dob := (v_kid ->> 'dob')::date;
      exception when others then
        v_dob := null;
      end;

      if nullif(trim(coalesce(v_kid ->> 'name', '')), '') is not null and v_dob is not null then
        insert into public.children (parent_id, name, date_of_birth, gender, interests)
        values (
          p_user_id,
          trim(v_kid ->> 'name'),
          v_dob,
          case when coalesce(v_kid ->> 'gender', '') in ('male', 'female', 'unspecified')
               then v_kid ->> 'gender' else 'unspecified' end,
          coalesce(
            (select array_agg(value::text) from jsonb_array_elements_text(v_kid -> 'interests')),
            '{}'::text[])
        );
      end if;
    end loop;
  end if;
end;
$$;

revoke all on function public.apply_signup_payload(uuid, jsonb) from public, anon, authenticated;

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
-- profile rows were not in place when the user row was first inserted.
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
  end if;
  return new;
end;
$$;

-- =============================================================
-- 4. Contact-form messages
-- =============================================================
-- QA: the contact form failed with "We couldn't send that just now". The send
-- fails because EMAIL_FROM is still Resend's shared `onboarding@resend.dev`
-- sender, which may only deliver to the Resend account owner. Storing every
-- message means none are lost while the domain is being verified, and gives
-- the founder a console to read them in.
create table if not exists public.contact_messages (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  email        text not null,
  subject      text,
  message      text not null,
  user_id      uuid references auth.users (id) on delete set null,
  emailed      boolean not null default false,
  email_error  text,
  created_at   timestamptz not null default now()
);

create index if not exists contact_messages_created_idx
  on public.contact_messages (created_at desc);

alter table public.contact_messages enable row level security;

-- Written by the API with the service role only; no client role may read the
-- inbox, and nothing here is exposed through PostgREST to anon/authenticated.
revoke all on public.contact_messages from anon, authenticated;

-- =============================================================
-- 5. Refresh PostgREST's schema cache
-- =============================================================
-- 00033 added `mark_own_attendance` and 00034 added `parent_profiles.avatar_seed`,
-- but the API kept answering "Could not find … in the schema cache", so both
-- features were dead in production. NOTIFY is how PostgREST is told to reload.
notify pgrst, 'reload schema';
