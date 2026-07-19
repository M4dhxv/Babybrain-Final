-- 00026_sow_addendum_features.sql
-- SOW addendum: vendor booking controls (pause/resume), package expiry +
-- class/slot restrictions, manual booking entry, cancellation/rescheduling
-- controls, child skill levels, conversion insights support, and named
-- recent bookings for vendors.

-- ============================================================
-- 1.1 / 2.2  Activity-level booking controls & policies
-- ============================================================
alter table public.activities
  add column if not exists bookings_paused boolean not null default false,
  add column if not exists allow_cancellation boolean not null default true,
  add column if not exists allow_rescheduling boolean not null default true,
  add column if not exists cancellation_cutoff_hours integer not null default 24,
  add column if not exists reschedule_cutoff_hours integer not null default 24;

-- ============================================================
-- 1.2  Package expiry + restriction to a weekly slot
--      (packages.activity_id already restricts to one activity)
-- ============================================================
alter table public.packages
  add column if not exists validity_days integer,
  add column if not exists allowed_weekday smallint
    check (allowed_weekday is null or allowed_weekday between 0 and 6), -- 0=Sun
  add column if not exists allowed_start_time time;                      -- SGT

-- Stamp expiry on purchase from the package's validity window.
create or replace function public.stamp_package_purchase_expiry()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_days integer;
begin
  if new.expires_at is null then
    select validity_days into v_days from public.packages where id = new.package_id;
    if v_days is not null then
      new.expires_at := now() + make_interval(days => v_days);
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists before_package_purchase_insert on public.package_purchases;
create trigger before_package_purchase_insert
  before insert on public.package_purchases
  for each row execute function public.stamp_package_purchase_expiry();

-- ============================================================
-- 2.1  Manual booking entry (vendor-recorded offline bookings)
-- ============================================================
alter table public.bookings
  alter column user_id drop not null,
  add column if not exists guest_name text,
  add column if not exists guest_contact text;

do $$ begin
  alter table public.bookings
    add constraint bookings_user_or_guest check (user_id is not null or guest_name is not null);
exception when duplicate_object then null; end $$;

drop policy if exists "managers add manual bookings" on public.bookings;
create policy "managers add manual bookings"
  on public.bookings for insert to authenticated
  with check (
    guest_name is not null
    and user_id is null
    and provider_id in (select public.user_manage_provider_ids())
  );

-- ============================================================
-- 2.4  Child skill levels (assigned per activity by the vendor)
-- ============================================================
create table if not exists public.child_skill_levels (
  id uuid primary key default gen_random_uuid(),
  child_id uuid not null references public.children(id) on delete cascade,
  activity_id uuid not null references public.activities(id) on delete cascade,
  level text not null check (level in ('beginner', 'intermediate', 'advanced')),
  notes text,
  set_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  unique (child_id, activity_id)
);

alter table public.child_skill_levels enable row level security;

drop policy if exists "members manage skill levels" on public.child_skill_levels;
create policy "members manage skill levels"
  on public.child_skill_levels for all to authenticated
  using (activity_id in (select id from public.activities where provider_id in (select public.user_provider_ids())))
  with check (activity_id in (select id from public.activities where provider_id in (select public.user_provider_ids())));

drop policy if exists "parents read own children's levels" on public.child_skill_levels;
create policy "parents read own children's levels"
  on public.child_skill_levels for select to authenticated
  using (child_id in (select id from public.children where parent_id = auth.uid()));

-- ============================================================
-- Booking insert defaults: pause enforcement + manual bookings
-- ============================================================
create or replace function public.enforce_booking_insert_defaults()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_price numeric;
  v_paused boolean;
  v_provider uuid;
  v_is_manager boolean := false;
begin
  if coalesce(auth.role(), '') = 'service_role' then
    return new;  -- trusted server path (Stripe webhook) sets its own state
  end if;

  select a.price, a.bookings_paused, a.provider_id
    into v_price, v_paused, v_provider
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  where s.id = new.session_id;

  v_is_manager := v_provider in (select public.user_manage_provider_ids());

  -- 1.1: parents cannot book a paused class; vendors can still record manual
  -- bookings against it.
  if coalesce(v_paused, false) and not v_is_manager then
    raise exception 'Bookings for this class are currently paused.';
  end if;

  -- Nobody but the server sets Stripe payment state.
  new.amount := null;
  new.stripe_payment_intent := null;

  if v_is_manager and new.guest_name is not null then
    -- 2.1: manual vendor booking — recorded as confirmed (waitlisted if the
    -- capacity trigger put it there); vendors may mark it paid (offline
    -- payment) but never refunded.
    if new.payment_status is null or new.payment_status not in ('none', 'paid') then
      new.payment_status := 'none';
    end if;
    if new.status is distinct from 'waitlisted' then
      new.status := 'confirmed';
      new.waitlist_position := null;
    end if;
  else
    new.payment_status := 'none';
    if new.status = 'waitlisted' then
      null; -- preserve status + position set by handle_booking_insert
    else
      new.waitlist_position := null;
      if coalesce(v_price, 0) = 0 then
        new.status := 'confirmed';   -- free class: nothing to pay
      else
        new.status := 'pending';     -- paid class: Stripe webhook confirms
      end if;
    end if;
  end if;
  return new;
end;
$function$;

-- ============================================================
-- 2.2  Parent-facing cancel / reschedule RPCs (policy-enforced)
-- ============================================================
create or replace function public.cancel_booking(p_booking_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_user uuid := auth.uid();
  v_bk public.bookings;
  v_allow boolean;
  v_cutoff integer;
  v_starts timestamptz;
begin
  if v_user is null then raise exception 'Not authenticated'; end if;

  select b.* into v_bk from public.bookings b
  where b.id = p_booking_id and b.user_id = v_user;
  if not found then raise exception 'Booking not found'; end if;
  if v_bk.status not in ('pending', 'confirmed', 'waitlisted') then
    raise exception 'This booking can no longer be cancelled.';
  end if;

  select a.allow_cancellation, a.cancellation_cutoff_hours, s.starts_at
    into v_allow, v_cutoff, v_starts
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  where s.id = v_bk.session_id;

  if not v_allow then
    raise exception 'The provider does not allow cancellations for this class.';
  end if;
  if v_starts - make_interval(hours => v_cutoff) < now() then
    raise exception 'The cancellation window for this class has closed (% hours before the session).', v_cutoff;
  end if;

  update public.bookings set status = 'cancelled' where id = p_booking_id;
end;
$$;

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

  select a.id, a.allow_rescheduling, a.reschedule_cutoff_hours, s.starts_at
    into v_act_id, v_allow, v_cutoff, v_old_starts
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
  return v_bk.status;
end;
$$;

-- ============================================================
-- 1.2  Package redemption: weekly-slot restriction + confirm
-- ============================================================
create or replace function public.redeem_package_credit(p_purchase_id uuid, p_session_id uuid)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_user uuid := auth.uid();
  v_pur public.package_purchases;
  v_pkg public.packages;
  v_session record;
  v_booking_id uuid;
  v_status text;
begin
  if v_user is null then
    raise exception 'Not authenticated';
  end if;

  select * into v_pur
  from public.package_purchases
  where id = p_purchase_id
    and user_id = v_user
    and status = 'active'
    and credits_remaining > 0
    and (expires_at is null or expires_at > now());
  if not found then
    raise exception 'No credits available on this package (it may have expired)';
  end if;

  select * into v_pkg from public.packages where id = v_pur.package_id;

  select s.id, s.starts_at, s.activity_id, a.provider_id
    into v_session
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  where s.id = p_session_id;

  if v_session.provider_id is null or v_session.provider_id <> v_pur.provider_id then
    raise exception 'This package can only be used for its provider''s classes';
  end if;
  if v_pkg.activity_id is not null and v_pkg.activity_id <> v_session.activity_id then
    raise exception 'This package is limited to a specific class';
  end if;
  if v_pkg.allowed_weekday is not null
     and extract(dow from v_session.starts_at at time zone 'Asia/Singapore') <> v_pkg.allowed_weekday then
    raise exception 'This package can only be redeemed for its designated weekly slot';
  end if;
  if v_pkg.allowed_start_time is not null
     and (v_session.starts_at at time zone 'Asia/Singapore')::time <> v_pkg.allowed_start_time then
    raise exception 'This package can only be redeemed for its designated weekly slot';
  end if;

  insert into public.bookings (user_id, session_id, child_id)
  values (v_user, p_session_id, null)
  returning id, status into v_booking_id, v_status;

  -- A credit pays for the class, so a paid-class booking confirms immediately
  -- (capacity overflow still waitlists).
  if v_status = 'pending' then
    update public.bookings set status = 'confirmed' where id = v_booking_id;
    v_status := 'confirmed';
  end if;

  update public.package_purchases
  set credits_remaining = credits_remaining - 1,
      status = case when credits_remaining - 1 <= 0 then 'used' else status end
  where id = p_purchase_id;

  return v_status;
end;
$function$;

-- Make-up token redemption: same confirm-on-redeem fix.
create or replace function public.redeem_make_up_token(p_token_id uuid, p_session_id uuid)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_user uuid := auth.uid();
  v_tok public.make_up_tokens;
  v_provider uuid;
  v_booking_id uuid;
  v_status text;
begin
  if v_user is null then
    raise exception 'Not authenticated';
  end if;

  select * into v_tok
  from public.make_up_tokens
  where id = p_token_id
    and user_id = v_user
    and status = 'issued'
    and (expires_at is null or expires_at > now());
  if not found then
    raise exception 'This make-up token is not available';
  end if;

  select a.provider_id into v_provider
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  where s.id = p_session_id;
  if v_provider is null or v_provider <> v_tok.provider_id then
    raise exception 'This token can only be used for its provider''s classes';
  end if;

  insert into public.bookings (user_id, session_id, child_id)
  values (v_user, p_session_id, v_tok.child_id)
  returning id, status into v_booking_id, v_status;

  if v_status = 'pending' then
    update public.bookings set status = 'confirmed' where id = v_booking_id;
    v_status := 'confirmed';
  end if;

  update public.make_up_tokens
  set status = 'redeemed', redeemed_booking_id = v_booking_id
  where id = p_token_id;

  return v_status;
end;
$function$;

-- ============================================================
-- 1.3 / 2.4  Roster: guest names, child ids, skill levels
-- ============================================================
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
  is_manual boolean
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
           coalesce(c.name, b.guest_name, 'Guest'),
           case when c.date_of_birth is not null
                then public.child_age_months(c.date_of_birth) end,
           b.medical_disclosure is not null,
           b.waitlist_position,
           at.status,
           b.child_id,
           sl.level,
           b.guest_name is not null
    from public.bookings b
    left join public.children c on c.id = b.child_id
    left join public.attendance at on at.booking_id = b.id
    left join public.child_skill_levels sl on sl.child_id = b.child_id and sl.activity_id = v_activity
    where b.session_id = p_session_id
    order by b.waitlist_position nulls first, b.created_at;
end;
$function$;

-- 1.3: recent bookings with the booked child's name, for the vendor dashboard.
create or replace function public.provider_recent_bookings(p_provider uuid, p_limit integer default 6)
returns table (
  booking_id uuid,
  child_name text,
  activity_title text,
  starts_at timestamptz,
  status text,
  created_at timestamptz
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
    select b.id,
           coalesce(c.name, b.guest_name, 'Guest'),
           a.title,
           s.starts_at,
           b.status,
           b.created_at
    from public.bookings b
    join public.activity_sessions s on s.id = b.session_id
    join public.activities a on a.id = s.activity_id
    left join public.children c on c.id = b.child_id
    where b.provider_id = p_provider
      and b.status <> 'cancelled'
    order by b.created_at desc
    limit least(coalesce(p_limit, 6), 50);
end;
$$;
