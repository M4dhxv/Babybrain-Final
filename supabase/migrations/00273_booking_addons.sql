-- 00273_booking_addons.sql
--
-- Extra people on a ticket, priced separately.
--
-- A vendor can offer add-ons on an activity — "Adult +$12", "Sibling +$8" — so one booking can carry
-- a child plus a parent (or both parents) without every person paying the full class price. A parent
-- ticks add-ons while booking, or adds them later to a booking they already hold and pays only the
-- add-on.
--
--   activity_addons : the vendor's catalogue for one activity (name, price, optional per-booking cap).
--   booking_addons  : what a parent actually bought on one booking, with the name and price copied at
--                     purchase time so a later price change never rewrites history.
--
-- Add-ons are headcount, not seats: they never touch bookings, capacity or waitlists. Money only moves
-- through the API routes (service role); parents and vendors can read, nobody writes from the browser.
-- Additive: nothing existing reads these tables, so old portal code keeps working untouched.
--
-- Two features share this migration:
--
--   1. COMPANION MODE (per activity): each pass includes N free companions of one type (adult or child)
--      chosen by the vendor, e.g. "a child comes with one adult". The parent gives name + age; the app
--      and API check the age matches the type. Stored as free booking_addons rows with kind 'companion'.
--   2. ADDITIONAL PEOPLE (per activity, off by default): paid add-ons on top of the pass, from the
--      vendor's catalogue below. Stored as kind 'additional'.
--
-- Packs: a pack that covers a companion-mode activity must be for that activity only (enforced by the
-- triggers at the bottom), and additional people are never bought from or with a pack.
--
-- Idempotent.

begin;

alter table public.activities
  add column if not exists companion_enabled boolean not null default false,
  add column if not exists companion_count int not null default 1 check (companion_count between 1 and 4),
  add column if not exists companion_type text not null default 'adult' check (companion_type in ('adult', 'child')),
  add column if not exists allow_additional_people boolean not null default false;
comment on column public.activities.companion_enabled is
  'Each pass includes companion_count free companions of companion_type (adult: 15 and over, child: 12 and under).';
comment on column public.activities.allow_additional_people is
  'Parents may buy extra people from activity_addons on top of the pass. Off by default.';

create table if not exists public.activity_addons (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null references public.activities (id) on delete cascade,
  provider_id uuid not null references public.providers (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 60),
  price_cents int not null default 0 check (price_cents between 0 and 100000),
  -- Most of this add-on one booking may carry (NULL = no limit beyond 10).
  max_per_booking int check (max_per_booking is null or max_per_booking between 1 and 10),
  -- Who the price is for, in whole years (either end may be NULL = no limit). "Child" is typically
  -- max_age 12, "Adult" min_age 15. The parent types each person's age; the app and the API refuse a mismatch.
  min_age int check (min_age is null or min_age between 0 and 120),
  max_age int check (max_age is null or max_age between 0 and 120),
  constraint activity_addons_age_order check (min_age is null or max_age is null or min_age <= max_age),
  active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists activity_addons_activity_idx on public.activity_addons (activity_id, active, sort_order);

create table if not exists public.booking_addons (
  id uuid primary key default gen_random_uuid(),
  -- The booking row the add-on hangs off (the lead seat of a party).
  booking_id uuid not null references public.bookings (id) on delete cascade,
  user_id uuid not null references public.parent_profiles (id) on delete cascade,
  provider_id uuid not null references public.providers (id) on delete cascade,
  addon_id uuid references public.activity_addons (id) on delete set null,
  name text not null,
  unit_price_cents int not null check (unit_price_cents >= 0),
  quantity int not null check (quantity between 1 and 10),
  -- One entry per person, blank allowed. Shown to the vendor on the roster.
  person_names text[] not null default '{}',
  -- companion = a free person included with the pass; additional = a paid extra from the catalogue.
  kind text not null default 'additional' check (kind in ('additional', 'companion')),
  -- Age in whole years of each person, same order as person_names (NULL = not given).
  person_ages int[] not null default '{}',
  -- The add-on's age range copied at purchase time, so the roster can flag a mismatch even after the
  -- vendor edits or deletes the add-on.
  age_min int,
  age_max int,
  -- pending = checkout started, not paid; paid = counts; cancelled = booking cancelled or checkout expired.
  payment_status text not null default 'pending' check (payment_status in ('pending', 'paid', 'cancelled')),
  stripe_payment_intent text,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);
create index if not exists booking_addons_booking_idx on public.booking_addons (booking_id);
create index if not exists booking_addons_user_idx on public.booking_addons (user_id, payment_status);
create index if not exists booking_addons_provider_idx on public.booking_addons (provider_id, payment_status);

alter table public.activity_addons enable row level security;
alter table public.booking_addons enable row level security;

-- Catalogue: anyone may read an active add-on (the booking page needs it); vendor team members read
-- all of theirs; only owners/managers write, and only against an activity that really is theirs.
drop policy if exists "read active addons" on public.activity_addons;
create policy "read active addons" on public.activity_addons
  for select using (active or provider_id in (select public.user_provider_ids()));

drop policy if exists "managers manage addons" on public.activity_addons;
create policy "managers manage addons" on public.activity_addons
  for all
  using (provider_id in (select public.user_manage_provider_ids()))
  with check (
    provider_id in (select public.user_manage_provider_ids())
    and exists (
      select 1 from public.activities a
      where a.id = activity_addons.activity_id and a.provider_id = activity_addons.provider_id
    )
  );

-- Purchases: a parent reads their own, the vendor's team reads theirs. No write policy on purpose.
drop policy if exists "read own booking addons" on public.booking_addons;
create policy "read own booking addons" on public.booking_addons
  for select using (user_id = auth.uid());

drop policy if exists "members read provider booking addons" on public.booking_addons;
create policy "members read provider booking addons" on public.booking_addons
  for select using (provider_id in (select public.user_provider_ids()));

comment on table public.activity_addons is
  'Vendor-defined extras on an activity (e.g. Adult +$12). Headcount only: never uses class capacity.';
comment on table public.booking_addons is
  'Add-ons a parent bought on one booking. Name and price are copied at purchase time. Written only by the API (service role).';

-- ---- Packs and companion mode ------------------------------------------------------------------
-- A pack that covers a companion-mode activity must cover that activity alone, and turning companion
-- mode on needs every active pack that reaches the activity to already be exclusive to it.
create or replace function public.packages_companion_exclusive() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.active is not true then return new; end if;
  if exists (
    select 1 from public.activities a
    where a.provider_id = new.provider_id
      and a.companion_enabled
      and a.archived_at is null
      and (
        coalesce(array_length(new.activity_ids, 1), 0) = 0
        or (a.id = any (new.activity_ids) and array_length(new.activity_ids, 1) > 1)
      )
  ) then
    raise exception 'A pack that covers a companion-mode class must be for that class only. Choose just that class, or keep the pack off the companion class.'
      using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function public.packages_companion_exclusive() from public, anon, authenticated;

drop trigger if exists packages_companion_exclusive on public.packages;
create trigger packages_companion_exclusive
  before insert or update of activity_ids, active, provider_id on public.packages
  for each row execute function public.packages_companion_exclusive();

create or replace function public.activities_companion_packs() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.companion_enabled is not true then return new; end if;
  if tg_op = 'UPDATE' and old.companion_enabled is true then return new; end if;
  if exists (
    select 1 from public.packages p
    where p.provider_id = new.provider_id
      and p.active
      and (
        coalesce(array_length(p.activity_ids, 1), 0) = 0
        or (new.id = any (p.activity_ids) and array_length(p.activity_ids, 1) > 1)
      )
  ) then
    raise exception 'Companion mode needs this class''s packs to be for this class only. Pause or edit the packs that also cover other classes (or any class), then turn it on.'
      using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function public.activities_companion_packs() from public, anon, authenticated;

drop trigger if exists activities_companion_packs on public.activities;
create trigger activities_companion_packs
  before insert or update of companion_enabled on public.activities
  for each row execute function public.activities_companion_packs();

-- ---- Old credits on a companion class --------------------------------------------------------------
-- redeem_package_credit is not touched here (it has been rewritten many times and other branches may
-- rewrite it again). Instead this guard sits on the booking row itself: a seat paid with a pack credit
-- on a companion-mode class is only accepted when that credit's pack is for that class alone. An older
-- any-class or multi-class credit keeps working everywhere else, and is refused here with a clear
-- message even if the API is called directly. Only the credit being attached is checked, so moving or
-- rescheduling an existing booking is never blocked.
create or replace function public.bookings_companion_pack_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_activity uuid;
  v_ids uuid[];
begin
  if new.package_purchase_id is null or new.session_id is null then return new; end if;
  if tg_op = 'UPDATE' and old.package_purchase_id is not distinct from new.package_purchase_id then return new; end if;
  select s.activity_id into v_activity from public.activity_sessions s where s.id = new.session_id;
  if v_activity is null then return new; end if;
  if not exists (select 1 from public.activities a where a.id = v_activity and a.companion_enabled) then return new; end if;
  select p.activity_ids into v_ids
  from public.package_purchases pp join public.packages p on p.id = pp.package_id
  where pp.id = new.package_purchase_id;
  if v_ids is null or array_length(v_ids, 1) is distinct from 1 or v_ids[1] <> v_activity then
    raise exception 'This class includes a companion, so it can only be booked with a pack made for this class alone. Buy this class''s own pack, or pay for the class directly.'
      using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function public.bookings_companion_pack_guard() from public, anon, authenticated;

drop trigger if exists bookings_companion_pack_guard on public.bookings;
create trigger bookings_companion_pack_guard
  before insert or update of package_purchase_id on public.bookings
  for each row execute function public.bookings_companion_pack_guard();

notify pgrst, 'reload schema';

commit;
