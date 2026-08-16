-- 00044_qa_round_6.sql
--
-- Founder QA round 6 (11/08 + 16/08 rows). Five independent pieces:
--
--   1. Reviews: drop the "must have booked it" restriction.
--   2/5. Bespoke consents/waivers: vendors define their own, parents accept
--      them at booking, acceptance is recorded and enforced in the database.
--   3. Rosters: never show a booking as "Guest" — fall back to the parent's
--      own name when there's no child on the booking.
--   4. Reschedule: notify the parent, both when they move their own booking
--      and when the vendor moves the whole session.
--   6. Insights: how many trial bookings convert into package sign-ups.

-- =============================================================
-- 1. Reviews — anyone signed in may review
--
-- QA: "Should be able to leave a review even if haven't been booked onto a
-- class on the platform as may have been another time and want to build these
-- up quickly." 00013 tied inserts to a confirmed/completed booking; that goes
-- away. The row is still pinned to auth.uid() so nobody can post as someone
-- else, and one-review-per-activity is still enforced by the table's own
-- unique constraint.
-- =============================================================
drop policy if exists "insert own review" on public.reviews;
create policy "insert own review" on public.reviews
  for insert with check (user_id = auth.uid());

-- =============================================================
-- 2. Bespoke consents, waivers and disclosures — tables
--
-- QA: "When creating a new activity there is an option if you want medical
-- disclosure added and when it is ticked as yes nothing different happens on
-- parents side… This won't always be medical disclosures, each vendor will
-- have their own consents, waivers, disclosures they want accepted so need a
-- way to make this bespoke", and "Parents need to accept waivers & policies
-- when making a booking (on vendor side there needs to be an option to toggle
-- on and upload the relevant material)".
--
-- A provider writes as many policies as they like. Each is either provider-
-- wide or pinned to one class, carries optional inline text and an optional
-- uploaded document, and is either required (must be ticked to book) or
-- informational. The tables come first because the roster in §3 reports on
-- them.
-- =============================================================
create table if not exists public.provider_policies (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references public.providers (id) on delete cascade,
  -- null → applies to every class this provider runs
  activity_id uuid references public.activities (id) on delete cascade,
  title text not null,
  body text not null default '',
  document_url text,
  required boolean not null default true,
  active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists provider_policies_provider_idx
  on public.provider_policies (provider_id, active);

comment on table public.provider_policies is
  'Vendor-authored consents / waivers / disclosures a parent must accept before booking.';

drop trigger if exists set_updated_at on public.provider_policies;
create trigger set_updated_at before update on public.provider_policies
  for each row execute function public.set_updated_at();

alter table public.provider_policies enable row level security;

-- Parents have to read these before they can accept them, so active policies
-- are public. Vendors see and manage all of their own, active or not.
drop policy if exists "read active provider policies" on public.provider_policies;
create policy "read active provider policies" on public.provider_policies
  for select using (active or provider_id in (select public.user_provider_ids()));

drop policy if exists "vendors manage own policies" on public.provider_policies;
create policy "vendors manage own policies" on public.provider_policies
  for all using (provider_id in (select public.user_manage_provider_ids()))
  with check (provider_id in (select public.user_manage_provider_ids()));

-- Which policies were accepted, and when. Written by trigger from the ids the
-- parent ticked, so the audit row can't drift from what actually gated the
-- booking.
create table if not exists public.booking_policy_acceptances (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings (id) on delete cascade,
  policy_id uuid not null references public.provider_policies (id) on delete cascade,
  user_id uuid references public.parent_profiles (id) on delete set null,
  -- Snapshot: a vendor editing the wording later must not rewrite history.
  policy_title text not null default '',
  accepted_at timestamptz not null default now(),
  unique (booking_id, policy_id)
);
create index if not exists booking_policy_acceptances_booking_idx
  on public.booking_policy_acceptances (booking_id);

alter table public.booking_policy_acceptances enable row level security;

drop policy if exists "read own or provider acceptances" on public.booking_policy_acceptances;
create policy "read own or provider acceptances" on public.booking_policy_acceptances
  for select using (
    user_id = auth.uid()
    or exists (
      select 1 from public.bookings b
      where b.id = booking_id
        and b.provider_id in (select public.user_provider_ids())
    )
  );

-- =============================================================
-- 3. "Guest" bookings on the vendor side
--
-- QA: "Some bookings are reflecting as Guest which shouldn't happen as we
-- always know the name and the vendor needs it to identify them at the
-- activity." A booking has no child row when the parent hadn't added a child
-- yet, but we always have the parent. Order of preference everywhere:
-- child name → manually-entered guest name → parent's own name → 'Guest'.
-- =============================================================
create or replace function public.booking_display_name(
  p_child_name text, p_guest_name text, p_parent_name text
)
returns text
language sql
immutable
set search_path to 'public'
as $$
  select coalesce(
    nullif(btrim(p_child_name), ''),
    nullif(btrim(p_guest_name), ''),
    nullif(btrim(p_parent_name), ''),
    'Guest'
  );
$$;

drop function if exists public.provider_session_roster(uuid);
create function public.provider_session_roster(p_session_id uuid)
returns table (
  booking_id uuid,
  status text,
  payment_status text,
  child_name text,
  child_age_months integer,
  has_medical boolean,
  waitlist_position integer,
  attendance_status text,
  child_id uuid,
  skill_level text,
  is_manual boolean,
  user_id uuid,
  parent_name text,
  medical_disclosure text,
  policies_accepted integer
)
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
  v_provider uuid;
  v_activity uuid;
begin
  select a.provider_id, a.id into v_provider, v_activity
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  where s.id = p_session_id;

  if v_provider is null or v_provider not in (select public.user_provider_ids()) then
    raise exception 'not authorized';
  end if;

  return query
    select b.id,
           b.status,
           b.payment_status,
           public.booking_display_name(c.name, b.guest_name, par.full_name),
           case when c.date_of_birth is not null
                then public.child_age_months(c.date_of_birth) end,
           b.medical_disclosure is not null,
           b.waitlist_position,
           at.status,
           b.child_id,
           sl.level,
           b.guest_name is not null,
           b.user_id,
           par.full_name,
           b.medical_disclosure,
           (select count(*)::int from public.booking_policy_acceptances bpa
             where bpa.booking_id = b.id)
    from public.bookings b
    left join public.children c on c.id = b.child_id
    left join public.parent_profiles par on par.id = b.user_id
    left join public.attendance at on at.booking_id = b.id
    left join public.child_skill_levels sl on sl.child_id = b.child_id and sl.activity_id = v_activity
    where b.session_id = p_session_id
    order by b.waitlist_position nulls first, b.created_at;
end;
$function$;

grant execute on function public.provider_session_roster(uuid) to authenticated;

drop function if exists public.provider_recent_bookings(uuid, integer);
create function public.provider_recent_bookings(p_provider uuid, p_limit integer default 6)
returns table (
  booking_id uuid,
  child_name text,
  activity_title text,
  starts_at timestamptz,
  status text,
  created_at timestamptz,
  is_repeat boolean,
  package_name text
)
language plpgsql
stable security definer
set search_path to 'public'
as $$
begin
  if p_provider not in (select public.user_provider_ids()) then
    raise exception 'not authorized';
  end if;

  return query
    select
      b.id,
      public.booking_display_name(c.name, b.guest_name, par.full_name),
      a.title,
      s.starts_at,
      b.status,
      b.created_at,
      exists (
        select 1 from public.bookings b2
        where b2.provider_id = b.provider_id
          and b2.user_id = b.user_id
          and b2.status <> 'cancelled'
          and b2.created_at < b.created_at
      ),
      pkg.name
    from public.bookings b
    join public.activity_sessions s on s.id = b.session_id
    join public.activities a on a.id = s.activity_id
    left join public.children c on c.id = b.child_id
    left join public.parent_profiles par on par.id = b.user_id
    left join public.package_purchases pp on pp.id = b.package_purchase_id
    left join public.packages pkg on pkg.id = pp.package_id
    where b.provider_id = p_provider
      and b.status <> 'cancelled'
    order by b.created_at desc
    limit least(coalesce(p_limit, 6), 50);
end;
$$;

grant execute on function public.provider_recent_bookings(uuid, integer) to authenticated;

-- =============================================================
-- 4. Reschedule notifications
--
-- QA: "When a class is re-scheduled, there is no notification received — a
-- notification should be received to confirm the action." Two ways a class
-- moves, so both are covered:
--   3a. the parent moves their own booking (reschedule_booking RPC), and
--   3b. the vendor moves the session itself, which silently moved every
--       booking on it.
-- =============================================================

-- 3a. Parent-initiated. Same body as 00026's version, plus the notification.
create or replace function public.reschedule_booking(p_booking_id uuid, p_new_session_id uuid)
returns text
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_user uuid := auth.uid();
  v_bk public.bookings;
  v_act_id uuid;
  v_act_title text;
  v_allow boolean;
  v_cutoff integer;
  v_old_starts timestamptz;
  v_new record;
  v_taken int;
begin
  if v_user is null then raise exception 'Not authenticated'; end if;

  select b.* into v_bk from public.bookings b
  where b.id = p_booking_id and b.user_id = v_user;
  if not found then raise exception 'Booking not found'; end if;
  if v_bk.status not in ('pending', 'confirmed') then
    raise exception 'Only upcoming bookings can be rescheduled.';
  end if;

  select a.id, a.title, a.allow_rescheduling, a.reschedule_cutoff_hours, s.starts_at
    into v_act_id, v_act_title, v_allow, v_cutoff, v_old_starts
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  where s.id = v_bk.session_id;

  if not v_allow then
    raise exception 'The provider does not allow rescheduling for this class.';
  end if;
  if v_old_starts - make_interval(hours => v_cutoff) < now() then
    raise exception 'The rescheduling window for this class has closed (% hours before the session).', v_cutoff;
  end if;

  select s.id, s.activity_id, s.starts_at, s.capacity into v_new
  from public.activity_sessions s where s.id = p_new_session_id;
  if v_new.id is null or v_new.activity_id <> v_act_id then
    raise exception 'You can only reschedule to another session of the same class.';
  end if;
  if v_new.starts_at <= now() then
    raise exception 'That session has already started.';
  end if;
  if v_new.capacity is not null then
    select count(*) into v_taken from public.bookings
    where session_id = p_new_session_id and status in ('pending', 'confirmed');
    if v_taken >= v_new.capacity then
      raise exception 'That session is full.';
    end if;
  end if;

  update public.bookings set session_id = p_new_session_id where id = p_booking_id;

  insert into public.notifications (user_id, type, title, body, data)
  values (
    v_user,
    'booking_rescheduled',
    'Booking moved',
    'Your booking for ' || coalesce(v_act_title, 'a class') || ' is now on ' ||
      to_char(v_new.starts_at at time zone 'Asia/Singapore', 'Dy DD Mon') || ' at ' ||
      to_char(v_new.starts_at at time zone 'Asia/Singapore', 'HH12:MIam') || '.',
    jsonb_build_object('url', '/profile?tab=bookings', 'booking_id', p_booking_id)
  );

  return v_bk.status;
end;
$$;

grant execute on function public.reschedule_booking(uuid, uuid) to authenticated;

-- 3b. Vendor-initiated: the session itself moved, so tell everyone on it.
create or replace function public.notify_session_rescheduled()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_title text;
begin
  if new.starts_at is distinct from old.starts_at then
    select a.title into v_title from public.activities a where a.id = new.activity_id;

    insert into public.notifications (user_id, type, title, body, data)
    select
      b.user_id,
      'session_rescheduled',
      'Class rescheduled',
      coalesce(v_title, 'A class') || ' has been moved by the provider — it now starts ' ||
        to_char(new.starts_at at time zone 'Asia/Singapore', 'Dy DD Mon') || ' at ' ||
        to_char(new.starts_at at time zone 'Asia/Singapore', 'HH12:MIam') || '.',
      jsonb_build_object('url', '/profile?tab=bookings', 'booking_id', b.id)
    from public.bookings b
    where b.session_id = new.id
      and b.user_id is not null
      and b.status in ('pending', 'confirmed', 'waitlisted');
  end if;
  return new;
end;
$$;

drop trigger if exists on_session_rescheduled on public.activity_sessions;
create trigger on_session_rescheduled
  after update of starts_at on public.activity_sessions
  for each row execute function public.notify_session_rescheduled();

-- =============================================================
-- 5. Consents/waivers — enforcement at booking time
-- =============================================================
-- The ticked ids travel on the booking insert so acceptance and booking are
-- one atomic act; there's no window where a booking exists unaccepted.
alter table public.bookings
  add column if not exists policies_accepted uuid[] not null default '{}';

comment on column public.bookings.policies_accepted is
  'provider_policies ids the parent ticked at booking time. Validated by enforce_booking_policies.';

/** Every required, active policy that applies to a session's class. */
create or replace function public.session_required_policies(p_session_id uuid)
returns setof public.provider_policies
language sql
stable
set search_path to 'public'
as $$
  select pp.*
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  join public.provider_policies pp
    on pp.provider_id = a.provider_id
   and (pp.activity_id is null or pp.activity_id = a.id)
  where s.id = p_session_id
    and pp.active
  order by pp.sort_order, pp.created_at;
$$;

grant execute on function public.session_required_policies(uuid) to anon, authenticated;

create or replace function public.enforce_booking_policies()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_missing text;
begin
  -- Vendors entering a walk-in take the paperwork on paper; only the parent
  -- self-serve path is gated.
  if coalesce(auth.role(), '') = 'service_role' or new.guest_name is not null then
    return new;
  end if;

  select string_agg(p.title, ', ')
    into v_missing
  from public.session_required_policies(new.session_id) p
  where p.required
    and not (p.id = any(coalesce(new.policies_accepted, '{}'::uuid[])));

  if v_missing is not null then
    raise exception 'Please accept the provider''s terms before booking: %', v_missing;
  end if;
  return new;
end;
$$;

drop trigger if exists booking_policy_gate on public.bookings;
create trigger booking_policy_gate
  before insert on public.bookings
  for each row execute function public.enforce_booking_policies();

create or replace function public.record_booking_policies()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(array_length(new.policies_accepted, 1), 0) > 0 then
    insert into public.booking_policy_acceptances (booking_id, policy_id, user_id, policy_title)
    select new.id, pp.id, new.user_id, pp.title
    from public.provider_policies pp
    where pp.id = any(new.policies_accepted)
    on conflict (booking_id, policy_id) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists booking_policy_record on public.bookings;
create trigger booking_policy_record
  after insert on public.bookings
  for each row execute function public.record_booking_policies();

-- Vendors upload the waiver/policy PDF itself. Public bucket: a parent has to
-- be able to read the document before they have any booking to tie it to.
insert into storage.buckets (id, name, public)
values ('provider-policies', 'provider-policies', true)
on conflict (id) do nothing;

drop policy if exists "policy documents are public" on storage.objects;
create policy "policy documents are public"
  on storage.objects for select
  using (bucket_id = 'provider-policies');

drop policy if exists "vendors upload policy documents" on storage.objects;
create policy "vendors upload policy documents"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'provider-policies'
    and (storage.foldername(name))[1] in (
      select id::text from public.providers
      where id in (select public.user_manage_provider_ids())
    )
  );

drop policy if exists "vendors update policy documents" on storage.objects;
create policy "vendors update policy documents"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'provider-policies'
    and (storage.foldername(name))[1] in (
      select id::text from public.providers
      where id in (select public.user_manage_provider_ids())
    )
  );

drop policy if exists "vendors delete policy documents" on storage.objects;
create policy "vendors delete policy documents"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'provider-policies'
    and (storage.foldername(name))[1] in (
      select id::text from public.providers
      where id in (select public.user_manage_provider_ids())
    )
  );

-- =============================================================
-- 6. Insights: trial → package conversion
--
-- QA (vendor): "Insights missing — if there is a trial option, how many
-- convert into package sign ups."
--
-- "Trial" isn't a booking type in the schema, so it's defined as what a trial
-- actually is: a parent's FIRST booking with this provider, paid for on its
-- own rather than out of a pack they already held. Converted = that parent
-- later bought a package from the same provider.
-- =============================================================
create or replace function public.provider_trial_conversion(p_provider uuid, p_days integer default 90)
returns table (
  trials integer,
  converted integer,
  conversion_rate numeric,
  median_days_to_convert numeric
)
language plpgsql
stable security definer
set search_path to 'public'
as $$
begin
  if p_provider not in (select public.user_provider_ids()) then
    raise exception 'not authorized';
  end if;

  return query
  with first_bookings as (
    select distinct on (b.user_id)
      b.user_id, b.created_at, b.package_purchase_id
    from public.bookings b
    where b.provider_id = p_provider
      and b.user_id is not null
      and b.status <> 'cancelled'
      and b.created_at > now() - make_interval(days => greatest(coalesce(p_days, 90), 1))
    order by b.user_id, b.created_at
  ),
  trials as (
    select * from first_bookings where package_purchase_id is null
  ),
  converts as (
    select t.user_id,
           min(pp.created_at) as bought_at,
           t.created_at as trialled_at
    from trials t
    join public.package_purchases pp
      on pp.user_id = t.user_id
     and pp.provider_id = p_provider
     and pp.created_at >= t.created_at
    group by t.user_id, t.created_at
  )
  select
    (select count(*)::int from trials),
    (select count(*)::int from converts),
    case when (select count(*) from trials) = 0 then null
         else round(
           (select count(*) from converts)::numeric * 100
           / (select count(*) from trials), 1)
    end,
    (select round(
        percentile_cont(0.5) within group (
          order by extract(epoch from (bought_at - trialled_at)) / 86400
        )::numeric, 1)
     from converts);
end;
$$;

grant execute on function public.provider_trial_conversion(uuid, integer) to authenticated;

notify pgrst, 'reload schema';
