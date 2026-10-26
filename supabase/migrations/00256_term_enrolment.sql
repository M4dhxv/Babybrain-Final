-- 00256_term_enrolment.sql
--
-- (Written as 00243 on the term-enrolment branch; renumbered 2026-10-26 so it sorts after what
-- production already has. Applied to the test database as 00243.)
--
-- Term enrolment: a vendor sells a named block of weekly sessions ("Term 4 ·
-- Saturday swim") that a parent enrols a child in once, instead of booking
-- session by session. Also: an optional trial session (limited per child), optional
-- single sessions, and package credits that work against a term's sessions.
--
-- Design — a term is NOT a second booking system. Publishing a term writes its
-- sessions as ordinary activity_sessions rows (tagged with term_slot_id), and
-- enrolling writes one ordinary bookings row per session. So the roster, the
-- calendar, attendance, reminders, cancellation, make-up tokens, earnings and
-- the Stripe webhook (kind 'booking', seat_ids) all keep working unchanged.
--
--   terms           the vendor's offer: price, mid-term rules, trial/single,
--                   package switch. One per activity run; many per activity.
--   term_slots      the choices a parent picks between (Sat 9:00 Tampines,
--                   Sat 10:30 Bishan). `pattern` holds how the sessions are
--                   generated; publish_term() turns it into sessions.
--   term_enrolments one child in one slot, with the price quoted at the time.
--
-- Rules enforced here, not in the UI:
--   * A term's sessions can only be booked through enrol_in_term(),
--     book_term_class() (trial / single) or a package credit when the term
--     allows packages. Anything else is refused by term_session_gate, so the
--     parent app's ordinary single-session flow cannot sell a term session at the
--     wrong price or bypass "singles off".
--   * Enrolling is all-or-nothing across the remaining sessions, under the
--     session-row locks handle_booking_insert already takes.
--   * Mid-term joining, the "stop at N sessions left" rule and the per-session
--     price reduction are computed here (term_quote), from the clock.
--   * Trial sessions are limited per child across all of a vendor's terms.
--   * Trial and single sessions can both be on, one at a time: while a child
--     has a trial left, single sessions are refused; once they have used the
--     vendor's trial limit they can book single sessions (when offered);
--     term_trial_remaining tells the booking page when to stop offering a trial.
--
-- Payment: /api/terms/checkout prices the seats (term price split across the
-- enrolment's rows, or the trial / single price) and sends them through the
-- same Stripe flow as /api/bookings/checkout. Per-session cancellation is the
-- existing cancel_booking path.
--
-- Not covered (deliberately, decide before building): cancelling a whole
-- enrolment at once, rescheduling a term booking onto a non-term session, and
-- redeeming a make-up token against a term session.
--
-- Idempotent.

begin;

-- =============================================================
-- 1. Tables
-- =============================================================
create table if not exists public.terms (
  id                uuid primary key default gen_random_uuid(),
  provider_id       uuid not null references public.providers (id) on delete cascade,
  activity_id       uuid not null references public.activities (id) on delete cascade,
  name              text not null check (length(btrim(name)) > 0),
  price_cents       int  not null check (price_cents >= 0),
  allow_mid_term    boolean not null default true,
  -- Stop taking new joiners once this many sessions are left.
  min_left          int  not null default 3 check (min_left >= 1),
  reduce_enabled    boolean not null default false,
  -- Taken off the price for every session that has already run.
  reduce_by_cents   int  not null default 0 check (reduce_by_cents >= 0),
  allow_singles     boolean not null default false,
  single_price_cents int not null default 0 check (single_price_cents >= 0),
  allow_trial       boolean not null default false,
  trial_price_cents int  not null default 0 check (trial_price_cents >= 0),
  -- Most trial sessions one child may take with this vendor.
  trial_limit       int  not null default 1 check (trial_limit between 1 and 10),
  allow_packages    boolean not null default true,
  status            text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  published_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists terms_provider_idx on public.terms (provider_id, status);
create index if not exists terms_activity_idx on public.terms (activity_id, status);

create table if not exists public.term_slots (
  id          uuid primary key default gen_random_uuid(),
  term_id     uuid not null references public.terms (id) on delete cascade,
  position    int  not null default 0,
  -- null = the activity's own venue.
  location_id uuid references public.provider_locations (id) on delete set null,
  capacity    int  not null check (capacity > 0),
  -- Most seats single/trial bookings may take on one session; null = no limit.
  single_cap  int  check (single_cap is null or single_cap >= 0),
  -- This slot's own full-term price; null = the term's price.
  price_cents int  check (price_cents is null or price_cents >= 0),
  -- How the sessions are generated:
  --   { "days":[6], "time":"09:00", "duration":45, "start":"2026-10-24",
  --     "weeks":10, "skip":["2026-10-31"],
  --     "perDay":true, "dayTimes":{"1":{"time":"16:00","duration":45}} }
  pattern     jsonb not null,
  session_count int  not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists term_slots_term_idx on public.term_slots (term_id, position);

create table if not exists public.term_enrolments (
  id               uuid primary key default gen_random_uuid(),
  term_id          uuid not null references public.terms (id) on delete restrict,
  slot_id          uuid not null references public.term_slots (id) on delete restrict,
  provider_id      uuid not null references public.providers (id) on delete cascade,
  user_id          uuid not null references public.parent_profiles (id) on delete cascade,
  child_id         uuid references public.children (id) on delete set null,
  -- What was quoted when the parent enrolled (after any mid-term reduction).
  price_cents      int  not null check (price_cents >= 0),
  sessions          int  not null check (sessions >= 1),
  booking_group_id uuid not null,
  created_at       timestamptz not null default now()
);
create index if not exists term_enrolments_user_idx on public.term_enrolments (user_id, created_at desc);
create index if not exists term_enrolments_slot_idx on public.term_enrolments (slot_id);
create index if not exists term_enrolments_provider_idx on public.term_enrolments (provider_id);

-- Does this activity offer terms at all? Off by default. While on, the vendor
-- portal locks the activity's own price and capacity (a term carries its own
-- per slot); while off, its Terms tab is locked.
alter table public.activities
  add column if not exists terms_enabled boolean not null default false;

alter table public.activity_sessions
  add column if not exists term_slot_id uuid references public.term_slots (id) on delete restrict,
  add column if not exists term_session_no int;
create index if not exists activity_sessions_term_slot_idx
  on public.activity_sessions (term_slot_id) where term_slot_id is not null;

alter table public.bookings
  add column if not exists term_enrolment_id uuid references public.term_enrolments (id) on delete set null,
  add column if not exists term_booking_kind text
    check (term_booking_kind is null or term_booking_kind in ('term', 'single', 'trial', 'package'));
create index if not exists bookings_term_enrolment_idx
  on public.bookings (term_enrolment_id) where term_enrolment_id is not null;
create index if not exists bookings_term_trial_idx
  on public.bookings (user_id, child_id) where term_booking_kind = 'trial';

drop trigger if exists set_updated_at on public.terms;
create trigger set_updated_at before update on public.terms
  for each row execute function public.set_updated_at();

-- =============================================================
-- 2. RLS — vendors manage their own; parents read what is on sale
-- =============================================================
alter table public.terms enable row level security;
alter table public.term_slots enable row level security;
alter table public.term_enrolments enable row level security;

drop policy if exists "read published terms" on public.terms;
create policy "read published terms" on public.terms
  for select using (status = 'published' or provider_id in (select public.user_provider_ids()));

drop policy if exists "members insert terms" on public.terms;
create policy "members insert terms" on public.terms
  for insert with check (
    provider_id in (select public.user_provider_ids())
    and status = 'draft'
    and exists (select 1 from public.activities a where a.id = terms.activity_id and a.provider_id = terms.provider_id)
  );

drop policy if exists "members update terms" on public.terms;
create policy "members update terms" on public.terms
  for update using (provider_id in (select public.user_provider_ids()))
  with check (
    provider_id in (select public.user_provider_ids())
    and exists (select 1 from public.activities a where a.id = terms.activity_id and a.provider_id = terms.provider_id)
  );

-- Only a draft can be deleted; a published term is archived instead, so the
-- sessions and bookings that hang off it are never orphaned.
drop policy if exists "members delete draft terms" on public.terms;
create policy "members delete draft terms" on public.terms
  for delete using (status = 'draft' and provider_id in (select public.user_provider_ids()));

drop policy if exists "read slots of readable terms" on public.term_slots;
create policy "read slots of readable terms" on public.term_slots
  for select using (
    exists (
      select 1 from public.terms t
      where t.id = term_slots.term_id
        and (t.status = 'published' or t.provider_id in (select public.user_provider_ids()))
    )
  );

drop policy if exists "members manage slots" on public.term_slots;
create policy "members manage slots" on public.term_slots
  for all using (
    exists (select 1 from public.terms t
            where t.id = term_slots.term_id and t.provider_id in (select public.user_provider_ids()))
  )
  with check (
    exists (select 1 from public.terms t
            where t.id = term_slots.term_id and t.provider_id in (select public.user_provider_ids()))
  );

-- Enrolments are written only by enrol_in_term().
drop policy if exists "read own enrolments" on public.term_enrolments;
create policy "read own enrolments" on public.term_enrolments
  for select using (user_id = auth.uid());
drop policy if exists "members read provider enrolments" on public.term_enrolments;
create policy "members read provider enrolments" on public.term_enrolments
  for select using (provider_id in (select public.user_provider_ids()));

-- =============================================================
-- 2b. The switch cannot be turned off under a running term
-- =============================================================
create or replace function public.guard_terms_enabled()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if old.terms_enabled and not new.terms_enabled and exists (
    select 1
    from public.terms t
    join public.term_slots ts on ts.term_id = t.id
    join public.activity_sessions s on s.term_slot_id = ts.id
    where t.activity_id = new.id
      and t.status = 'published'
      and s.status is distinct from 'cancelled'
      and s.starts_at > now()
  ) then
    raise exception 'A published term still has sessions to run. Let it finish before turning terms off.';
  end if;
  return new;
end;
$$;

drop trigger if exists activities_terms_enabled_guard on public.activities;
create trigger activities_terms_enabled_guard before update of terms_enabled on public.activities
  for each row execute function public.guard_terms_enabled();

-- =============================================================
-- 3. Published slots: patterns are frozen; capacity flows to the sessions
-- =============================================================
create or replace function public.guard_term_slot_update()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_status text;
begin
  select t.status into v_status from public.terms t where t.id = new.term_id;
  if v_status = 'published' or v_status = 'archived' then
    if (new.pattern is distinct from old.pattern or new.location_id is distinct from old.location_id)
       and coalesce(current_setting('bb.term_skip', true), '') <> 'on' then
      raise exception 'A published term''s days, times and venue are fixed. Skip a session instead, or start a new term.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists term_slot_guard on public.term_slots;
create trigger term_slot_guard before update on public.term_slots
  for each row execute function public.guard_term_slot_update();

create or replace function public.term_slot_capacity_follow()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if new.capacity is distinct from old.capacity then
    -- Upcoming sessions only; the existing capacity-increase trigger offers a
    -- freed seat to the waitlist exactly as it does for a manual change.
    update public.activity_sessions
       set capacity = new.capacity
     where term_slot_id = new.id and starts_at > now() and status is distinct from 'cancelled';
  end if;
  return new;
end;
$$;

drop trigger if exists term_slot_capacity on public.term_slots;
create trigger term_slot_capacity after update of capacity on public.term_slots
  for each row execute function public.term_slot_capacity_follow();

-- =============================================================
-- 4. Quote: what a parent would pay for a slot, right now
-- =============================================================
create or replace function public.term_quote(p_slot_id uuid)
returns table (
  sessions_total  int,
  sessions_passed int,
  sessions_left   int,
  joinable       boolean,
  price_cents    int,
  reason         text
)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_slot   public.term_slots;
  v_term   public.terms;
  v_cutoff int;
  v_total  int;
  v_left   int;
  v_passed int;
  v_base   int;
  v_price  int;
  v_ok     boolean := true;
  v_reason text;
begin
  select ts.* into v_slot from public.term_slots ts where ts.id = p_slot_id;
  if not found then
    raise exception 'That slot does not exist';
  end if;
  select t.* into v_term from public.terms t where t.id = v_slot.term_id and t.status = 'published';
  if not found then
    raise exception 'This term is not open for enrolment';
  end if;
  select coalesce(a.booking_cutoff_minutes, 15) into v_cutoff
  from public.activities a where a.id = v_term.activity_id;

  -- A session counts as "run" once its booking window has closed — the same
  -- moment enforce_booking_insert_defaults would refuse a booking on it.
  select count(*) filter (where s.status is distinct from 'cancelled'),
         count(*) filter (where s.status is distinct from 'cancelled'
                            and s.starts_at - make_interval(mins => coalesce(s.booking_cutoff_minutes, v_cutoff)) > now())
    into v_total, v_left
  from public.activity_sessions s
  where s.term_slot_id = p_slot_id;

  v_passed := v_total - v_left;
  v_base := coalesce(v_slot.price_cents, v_term.price_cents);
  v_price := case when v_term.reduce_enabled
                  then greatest(0, v_base - v_term.reduce_by_cents * v_passed)
                  else v_base end;

  if v_left = 0 then
    v_ok := false;
    v_reason := 'This term has finished.';
  elsif v_passed > 0 and not v_term.allow_mid_term then
    v_ok := false;
    v_reason := 'This term has started and is closed to new joiners.';
  elsif v_passed > 0 and v_left < v_term.min_left then
    v_ok := false;
    v_reason := 'This term is closed to new joiners with only ' || v_left || ' sessions left.';
  end if;

  return query select v_total, v_passed, v_left, v_ok, v_price, v_reason;
end;
$$;

-- =============================================================
-- 5. Publish: turn each slot's pattern into real sessions
-- =============================================================
create or replace function public.publish_term(p_term_id uuid)
returns int
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_term    public.terms;
  v_act     record;
  v_slot    public.term_slots;
  v_p       jsonb;
  v_start   date;
  v_weeks   int;
  v_count   int;
  v_limit   int;
  v_days    int[];
  v_skip    text[];
  v_per     boolean;
  v_i       int;
  v_d       date;
  v_dow     int;
  v_time    time;
  v_dur     int;
  v_n       int;
  v_all     int := 0;
  v_base    int;
  v_rate    numeric;
begin
  select * into v_term from public.terms where id = p_term_id for update;
  if not found then
    raise exception 'Term not found';
  end if;
  if v_term.provider_id not in (select public.user_provider_ids()) then
    raise exception 'not authorized';
  end if;
  if v_term.status <> 'draft' then
    raise exception 'This term is already published.';
  end if;

  select a.provider_id, a.terms_enabled, a.wix_service_id, a.wix_event_id, a.wix_series_id, a.wix_service_type
    into v_act
  from public.activities a where a.id = v_term.activity_id;
  if not found or v_act.provider_id <> v_term.provider_id then
    raise exception 'That activity is not yours.';
  end if;
  -- A Wix-linked activity's schedule belongs to Wix and is re-mirrored
  -- constantly; sessions written here would be swept away or become slots Wix
  -- refuses to book.
  if v_act.wix_service_id is not null or v_act.wix_event_id is not null
     or v_act.wix_series_id is not null or v_act.wix_service_type is not null then
    raise exception 'Terms are for activities you run on BabyBrain, not Wix-linked ones.';
  end if;
  if not v_act.terms_enabled then
    raise exception 'Turn on "Offer this activity as a term" for this activity first.';
  end if;
  if not exists (select 1 from public.term_slots where term_id = p_term_id) then
    raise exception 'Add at least one slot before publishing.';
  end if;

  for v_slot in
    select * from public.term_slots where term_id = p_term_id order by position, created_at
  loop
    v_p := v_slot.pattern;
    v_start := (v_p ->> 'start')::date;
    v_weeks := greatest(1, least(104, coalesce((v_p ->> 'weeks')::int, 1)));
    -- By sessions: run until this many non-skipped sessions are placed. A
    -- skipped date is not counted, so a holiday pushes the end out. The span
    -- is only a ceiling (200 sessions) so a bad pattern cannot loop forever.
    v_count := nullif(v_p ->> 'count', '')::int;
    if v_count is not null then
      v_count := greatest(1, least(200, v_count));
    end if;
    v_limit := case when v_count is not null then 7 * 210 else v_weeks * 7 end;
    v_days := array(select (jsonb_array_elements_text(coalesce(v_p -> 'days', '[]'::jsonb)))::int);
    v_skip := array(select jsonb_array_elements_text(coalesce(v_p -> 'skip', '[]'::jsonb)));
    v_per := coalesce((v_p ->> 'perDay')::boolean, false);
    if v_start is null then
      raise exception 'Every slot needs a first session date.';
    end if;
    if coalesce(array_length(v_days, 1), 0) = 0 then
      raise exception 'Every slot needs at least one day of the week.';
    end if;

    v_n := 0;
    for v_i in 0 .. (v_limit - 1) loop
      v_d := v_start + v_i;
      v_dow := extract(dow from v_d)::int;
      continue when not (v_dow = any (v_days));
      continue when to_char(v_d, 'YYYY-MM-DD') = any (v_skip);

      v_time := coalesce(
        nullif(case when v_per then v_p -> 'dayTimes' -> v_dow::text ->> 'time' end, ''),
        v_p ->> 'time'
      )::time;
      v_dur := coalesce(
        nullif(case when v_per then v_p -> 'dayTimes' -> v_dow::text ->> 'duration' end, '')::int,
        (v_p ->> 'duration')::int
      );
      if v_time is null or v_dur is null or v_dur < 1 then
        raise exception 'Every slot needs a start time and a length.';
      end if;

      v_n := v_n + 1;
      insert into public.activity_sessions
        (activity_id, starts_at, ends_at, capacity, location_id, term_slot_id, term_session_no)
      values (
        v_term.activity_id,
        (v_d + v_time) at time zone 'Asia/Singapore',
        ((v_d + v_time) at time zone 'Asia/Singapore') + make_interval(mins => v_dur),
        v_slot.capacity,
        v_slot.location_id,
        v_slot.id,
        v_n
      );

      exit when v_count is not null and v_n >= v_count;
    end loop;

    if v_n = 0 then
      raise exception 'A slot has no sessions left. Un-skip a date or change the days.';
    end if;

    -- The session's own price only decides free vs paid for the booking
    -- triggers (a session priced 0 auto-confirms). What a parent is actually
    -- charged is set by /api/terms/checkout from the term, so this is just the
    -- per-session share, never zero for a paid term.
    v_base := coalesce(v_slot.price_cents, v_term.price_cents);
    v_rate := case when v_base > 0 then greatest(0.01, round(v_base / 100.0 / v_n, 2)) else 0 end;
    update public.activity_sessions set price = v_rate where term_slot_id = v_slot.id;
    update public.term_slots set session_count = v_n where id = v_slot.id;
    v_all := v_all + v_n;
  end loop;

  update public.terms set status = 'published', published_at = now() where id = p_term_id;
  return v_all;
end;
$$;

-- =============================================================
-- 6. The booking gate
-- =============================================================
create or replace function public.term_session_gate()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_slot_id uuid;
  v_slot    public.term_slots;
  v_term    public.terms;
  v_kind    text;
  v_enrol   uuid;
  v_taken   int;
  v_used    int;
begin
  select s.term_slot_id into v_slot_id from public.activity_sessions s where s.id = new.session_id;
  if v_slot_id is null then
    return new;                       -- an ordinary session: not our business
  end if;
  if coalesce(auth.role(), '') = 'service_role' then
    return new;                       -- trusted server paths
  end if;

  select ts.* into v_slot from public.term_slots ts where ts.id = v_slot_id;
  select t.* into v_term from public.terms t where t.id = v_slot.term_id;
  -- A vendor adding their own manual booking.
  if v_term.provider_id in (select public.user_manage_provider_ids()) then
    return new;
  end if;
  if v_term.status <> 'published' then
    raise exception 'This session is not open for booking.';
  end if;

  -- The kind comes only from the transaction-local setting our RPCs make, never
  -- from the row: a parent can insert their own bookings under RLS and could
  -- otherwise stamp term_booking_kind themselves and walk through this gate.
  v_kind := nullif(current_setting('bb.term_booking_kind', true), '');

  if v_kind is null then
    if new.package_purchase_id is not null then
      if not v_term.allow_packages then
        raise exception 'This term does not accept package credits.';
      end if;
      v_kind := 'package';
    else
      raise exception 'This session is part of a term. Enrol in the term, or book a trial or single session from the term page.';
    end if;
  end if;

  if v_kind = 'term' then
    v_enrol := nullif(current_setting('bb.term_enrolment_id', true), '')::uuid;
  elsif v_kind in ('single', 'trial') then
    if v_kind = 'single' and not v_term.allow_singles then
      raise exception 'Single sessions are not offered for this term.';
    end if;
    if v_kind = 'trial' and not v_term.allow_trial then
      raise exception 'There is no trial session for this term.';
    end if;
    if v_slot.single_cap is not null then
      select count(*) into v_taken
      from public.bookings b
      where b.session_id = new.session_id
        and b.term_booking_kind in ('single', 'trial')
        and b.status in ('pending', 'confirmed');
      if v_taken >= v_slot.single_cap then
        raise exception 'The single-session places for this session are full. You can still enrol in the term.';
      end if;
    end if;
    -- Trials are counted for a trial booking, and for a single booking on a
    -- term that has a trial: for now a single session is only offered once
    -- the child has used their trial (the booking page hides it until then).
    if v_kind = 'trial' or (v_kind = 'single' and v_term.allow_trial) then
      select count(*) into v_used
      from public.bookings b
      join public.activity_sessions s2 on s2.id = b.session_id
      join public.term_slots ts2 on ts2.id = s2.term_slot_id
      join public.terms t2 on t2.id = ts2.term_id
      where b.term_booking_kind = 'trial'
        and t2.provider_id = v_term.provider_id
        and b.status not in ('cancelled', 'waitlisted')
        and (
          (new.child_id is not null and b.child_id = new.child_id)
          or (new.child_id is null and b.child_id is null and b.user_id = new.user_id)
        );
      if v_kind = 'trial' and v_used >= v_term.trial_limit then
        raise exception 'The trial session limit for this child has been reached (%).', v_term.trial_limit;
      end if;
      if v_kind = 'single' and v_used < v_term.trial_limit then
        raise exception 'Book the trial session first. Single sessions open once this child has used their trial.';
      end if;
    end if;
  elsif v_kind <> 'package' then
    raise exception 'That booking type is not available for this session.';
  end if;

  new.term_booking_kind := v_kind;
  new.term_enrolment_id := v_enrol;
  return new;
end;
$$;

drop trigger if exists term_session_gate on public.bookings;
create trigger term_session_gate before insert on public.bookings
  for each row execute function public.term_session_gate();

-- =============================================================
-- 7. Parent: enrol a child in a term slot
-- =============================================================
create or replace function public.enrol_in_term(
  p_slot_id   uuid,
  p_child_id  uuid default null,
  p_policies  uuid[] default '{}',
  p_medical   text default null,
  p_info      text default null
)
returns table (enrolment_id uuid, group_id uuid, status text, price_cents int, sessions int)
language plpgsql
security definer
set search_path to 'public'
as $$
#variable_conflict use_column
declare
  v_user     uuid := auth.uid();
  v_slot     public.term_slots;
  v_term     public.terms;
  v_act      record;
  v_child    uuid;
  v_quote    record;
  v_cutoff   int;
  v_ids      uuid[];
  v_sid      uuid;
  v_cap      int;
  v_taken    int;
  v_enrol    uuid;
  v_group    uuid;
  v_status   text;
  v_prev     record;
begin
  if v_user is null then
    raise exception 'Please log in again to enrol';
  end if;

  select ts.* into v_slot from public.term_slots ts where ts.id = p_slot_id for update;
  if not found then
    raise exception 'That slot is no longer available';
  end if;
  select t.* into v_term from public.terms t where t.id = v_slot.term_id and t.status = 'published';
  if not found then
    raise exception 'This term is not open for enrolment';
  end if;
  select a.bookings_paused, a.booking_cutoff_minutes into v_act
  from public.activities a where a.id = v_term.activity_id;
  if coalesce(v_act.bookings_paused, false) then
    raise exception 'Bookings for this session are currently paused.';
  end if;
  v_cutoff := coalesce(v_act.booking_cutoff_minutes, 15);

  if p_child_id is not null then
    select c.id into v_child from public.children c where c.id = p_child_id and c.parent_id = v_user;
    if v_child is null then
      raise exception 'That child is no longer on your profile — pick another';
    end if;
  end if;

  select * into v_quote from public.term_quote(p_slot_id);
  if not v_quote.joinable then
    raise exception '%', coalesce(v_quote.reason, 'This term is not open for enrolment');
  end if;

  -- An unpaid attempt for this child and slot: hand it back, as book_party does.
  select e.id, e.booking_group_id, e.price_cents, e.sessions into v_prev
  from public.term_enrolments e
  where e.user_id = v_user and e.slot_id = p_slot_id
    and e.child_id is not distinct from v_child
    and exists (select 1 from public.bookings b
                where b.term_enrolment_id = e.id and b.status = 'pending' and b.payment_status = 'none')
  order by e.created_at desc
  limit 1;
  if found then
    return query select v_prev.id, v_prev.booking_group_id, 'pending'::text, v_prev.price_cents, v_prev.sessions;
    return;
  end if;

  -- Already enrolled (paid or free): refuse rather than double up.
  if exists (
    select 1 from public.term_enrolments e
    join public.bookings b on b.term_enrolment_id = e.id
    where e.user_id = v_user and e.slot_id = p_slot_id
      and e.child_id is not distinct from v_child
      and b.status in ('confirmed', 'pending')
  ) then
    raise exception 'This child is already enrolled in this slot.';
  end if;

  -- Lock every session still to come, in a fixed order, and check each has a seat.
  select array_agg(q.id order by q.starts_at, q.id) into v_ids
  from (
    select s.id, s.starts_at
    from public.activity_sessions s
    where s.term_slot_id = p_slot_id
      and s.status is distinct from 'cancelled'
      and s.starts_at - make_interval(mins => coalesce(s.booking_cutoff_minutes, v_cutoff)) > now()
    order by s.starts_at, s.id
    for update of s
  ) q;
  if v_ids is null or array_length(v_ids, 1) = 0 then
    raise exception 'There are no sessions left to enrol in.';
  end if;

  foreach v_sid in array v_ids loop
    select s.capacity into v_cap from public.activity_sessions s where s.id = v_sid;
    if v_cap is not null then
      select count(*) into v_taken from public.bookings b
      where b.session_id = v_sid and b.status in ('pending', 'confirmed');
      if v_taken >= v_cap then
        raise exception 'This slot is full: at least one session has no place left.';
      end if;
    end if;
  end loop;

  v_group := gen_random_uuid();
  insert into public.term_enrolments (term_id, slot_id, provider_id, user_id, child_id, price_cents, sessions, booking_group_id)
  values (v_term.id, p_slot_id, v_term.provider_id, v_user, v_child, v_quote.price_cents, array_length(v_ids, 1), v_group)
  returning id into v_enrol;

  perform set_config('bb.term_booking_kind', 'term', true);
  perform set_config('bb.term_enrolment_id', v_enrol::text, true);
  foreach v_sid in array v_ids loop
    insert into public.bookings (user_id, session_id, child_id, policies_accepted,
                                 medical_disclosure, info_response, booking_group_id)
    values (
      v_user, v_sid, v_child, coalesce(p_policies, '{}'::uuid[]),
      nullif(btrim(p_medical), ''), nullif(btrim(p_info), ''), v_group
    );
  end loop;
  perform set_config('bb.term_booking_kind', '', true);
  perform set_config('bb.term_enrolment_id', '', true);

  select case when bool_or(b.status = 'pending') then 'pending' else 'confirmed' end
    into v_status
  from public.bookings b where b.booking_group_id = v_group;

  return query select v_enrol, v_group, v_status, v_quote.price_cents, array_length(v_ids, 1);
end;
$$;

-- =============================================================
-- 8. Parent: a trial or single session from a term
-- =============================================================
create or replace function public.book_term_class(
  p_session_id  uuid,
  p_kind        text,
  p_child_id    uuid default null,
  p_guest_names text[] default '{}',
  p_policies    uuid[] default '{}',
  p_medical     text default null,
  p_info        text default null
)
returns table (group_id uuid, status text, waitlisted_count int)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_user  uuid := auth.uid();
  v_slot  uuid;
begin
  if v_user is null then
    raise exception 'Please log in again to book';
  end if;
  if p_kind not in ('single', 'trial') then
    raise exception 'Choose a single or trial session.';
  end if;
  select s.term_slot_id into v_slot from public.activity_sessions s where s.id = p_session_id;
  if v_slot is null then
    raise exception 'This session is not part of a term.';
  end if;
  -- A trial is one seat for one child. (The gate also enforces the limit.)
  if p_kind = 'trial' and coalesce(array_length(p_guest_names, 1), 0) > 0 then
    raise exception 'A trial session is for one child.';
  end if;

  perform set_config('bb.term_booking_kind', p_kind, true);
  return query select * from public.book_party(p_session_id, p_child_id, p_guest_names, p_policies, p_medical, p_info);
  perform set_config('bb.term_booking_kind', '', true);
end;
$$;

-- =============================================================
-- 9. Vendor: skip one session of a published term
-- =============================================================
create or replace function public.skip_term_class(p_session_id uuid)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_slot   uuid;
  v_starts timestamptz;
  v_ymd    text;
  v_n      integer;
begin
  select s.term_slot_id, s.starts_at into v_slot, v_starts
  from public.activity_sessions s where s.id = p_session_id;
  if v_slot is null then
    raise exception 'This session is not part of a term.';
  end if;
  v_ymd := to_char(v_starts at time zone 'Asia/Singapore', 'YYYY-MM-DD');

  -- vendor_cancel_session authorises the caller (a member of the provider),
  -- cancels the families' bookings and notifies them (00154).
  v_n := public.vendor_cancel_session(p_session_id);

  perform set_config('bb.term_skip', 'on', true);
  update public.term_slots ts
     set pattern = jsonb_set(
           ts.pattern, '{skip}',
           coalesce(ts.pattern -> 'skip', '[]'::jsonb) || to_jsonb(v_ymd)
         ),
         session_count = greatest(0, ts.session_count - 1)
   where ts.id = v_slot
     and not (coalesce(ts.pattern -> 'skip', '[]'::jsonb) ? v_ymd);
  perform set_config('bb.term_skip', '', true);
  return v_n;
end;
$$;

-- =============================================================
-- 9a. How many trial sessions a child still has with this vendor
-- =============================================================
-- Trial and single sessions can both be on. The booking page offers a trial
-- only while the child still has one left; once they have used the vendor's
-- limit, only single sessions (when offered) are shown. Counted the same way
-- as term_session_gate counts: per child (or per parent when no child is
-- chosen), across all of the vendor's terms. The limit is the highest one among
-- this activity's published terms that offer a trial.
create or replace function public.term_trial_remaining(p_activity_id uuid, p_child_id uuid default null)
returns table (used int, trial_limit int, remaining int)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
#variable_conflict use_column
declare
  v_user     uuid := auth.uid();
  v_provider uuid;
  v_limit    int;
  v_used     int;
begin
  if v_user is null then
    raise exception 'Please log in again';
  end if;
  -- Never answer for someone else's child.
  if p_child_id is not null
     and not exists (select 1 from public.children c where c.id = p_child_id and c.parent_id = v_user) then
    raise exception 'That child is no longer on your profile';
  end if;

  select a.provider_id into v_provider from public.activities a where a.id = p_activity_id;
  select max(t.trial_limit) into v_limit
  from public.terms t
  where t.activity_id = p_activity_id and t.status = 'published' and t.allow_trial;
  if v_provider is null or v_limit is null then
    return query select 0, 0, 0;
    return;
  end if;

  select count(*) into v_used
  from public.bookings b
  join public.activity_sessions s2 on s2.id = b.session_id
  join public.term_slots ts2 on ts2.id = s2.term_slot_id
  join public.terms t2 on t2.id = ts2.term_id
  where b.term_booking_kind = 'trial'
    and t2.provider_id = v_provider
    and b.status not in ('cancelled', 'waitlisted')
    and (
      (p_child_id is not null and b.child_id = p_child_id)
      or (p_child_id is null and b.child_id is null and b.user_id = v_user)
    );

  return query select v_used::int, v_limit, greatest(0, v_limit - v_used)::int;
end;
$$;

-- =============================================================
-- 9c. Is an activity open to packages?
-- =============================================================
-- Closed when the activity has terms switched on and none of its published
-- terms with a session still to run accept package credits: its sessions all
-- come from those terms, so a pack limited to it could be bought but never
-- spent. Only activities that are closed come back; anything else is open.
-- The parent app uses it to stop offering packs there.
create or replace function public.activity_packages_closed(p_activity_ids uuid[])
returns table (activity_id uuid)
language sql
stable
security definer
set search_path to 'public'
as $$
  select t.activity_id
  from public.terms t
  join public.activities a on a.id = t.activity_id and a.terms_enabled
  where t.activity_id = any (p_activity_ids)
    and t.status = 'published'
    and exists (
      select 1
      from public.term_slots ts
      join public.activity_sessions s on s.term_slot_id = ts.id
      where ts.term_id = t.id
        and s.status is distinct from 'cancelled'
        and s.starts_at > now()
    )
  group by t.activity_id
  having not bool_or(t.allow_packages);
$$;

-- =============================================================
-- 9b. The price an activity leads with while it offers terms
-- =============================================================
-- Explore cards and the activity page show ONE price. With terms on it is, in
-- order: the trial session price (if a term has a trial session), else the single
-- session price (if a term sells single sessions), else the lowest term price the
-- vendor is showing. "Showing" = a published term with a session still to run, on
-- an activity that has terms switched on. Lowest is across terms and slots, at
-- the full price (before any mid-term reduction).
--
-- Set-based and index-friendly (terms_activity_idx), and called with only the
-- ids on screen, so a page of cards costs one small query.
create or replace function public.term_headline_prices(p_activity_ids uuid[])
returns table (activity_id uuid, kind text, price_cents int)
language sql
stable
security definer
set search_path to 'public'
as $$
  with live as (
    select t.*
    from public.terms t
    join public.activities a on a.id = t.activity_id and a.terms_enabled
    where t.activity_id = any (p_activity_ids)
      and t.status = 'published'
      and exists (
        select 1
        from public.term_slots ts
        join public.activity_sessions s on s.term_slot_id = ts.id
        where ts.term_id = t.id
          and s.status is distinct from 'cancelled'
          and s.starts_at > now()
      )
  ),
  priced as (
    select l.activity_id,
           l.allow_trial, l.trial_price_cents,
           l.allow_singles, l.single_price_cents,
           (select min(coalesce(ts.price_cents, l.price_cents))
              from public.term_slots ts where ts.term_id = l.id) as term_price_cents
    from live l
  ),
  agg as (
    select p.activity_id,
           min(p.trial_price_cents) filter (where p.allow_trial) as trial_cents,
           min(p.single_price_cents) filter (where p.allow_singles) as single_cents,
           min(p.term_price_cents) as term_cents
    from priced p
    group by p.activity_id
  )
  select g.activity_id,
         case when g.trial_cents is not null then 'trial'
              when g.single_cents is not null then 'single'
              else 'term' end,
         coalesce(g.trial_cents, g.single_cents, g.term_cents)
  from agg g
  where coalesce(g.trial_cents, g.single_cents, g.term_cents) is not null;
$$;

-- =============================================================
-- 10. Who may call what
-- =============================================================
revoke all on function public.guard_terms_enabled() from public, anon, authenticated;
revoke all on function public.guard_term_slot_update() from public, anon, authenticated;
revoke all on function public.term_slot_capacity_follow() from public, anon, authenticated;
revoke all on function public.term_session_gate() from public, anon, authenticated;

revoke all on function public.term_trial_remaining(uuid, uuid) from public, anon;
grant execute on function public.term_trial_remaining(uuid, uuid) to authenticated;

revoke all on function public.activity_packages_closed(uuid[]) from public;
grant execute on function public.activity_packages_closed(uuid[]) to anon, authenticated;

revoke all on function public.term_headline_prices(uuid[]) from public;
grant execute on function public.term_headline_prices(uuid[]) to anon, authenticated;

revoke all on function public.term_quote(uuid) from public;
grant execute on function public.term_quote(uuid) to anon, authenticated;

revoke all on function public.publish_term(uuid) from public, anon;
grant execute on function public.publish_term(uuid) to authenticated;

revoke all on function public.enrol_in_term(uuid, uuid, uuid[], text, text) from public, anon;
grant execute on function public.enrol_in_term(uuid, uuid, uuid[], text, text) to authenticated;

revoke all on function public.book_term_class(uuid, text, uuid, text[], uuid[], text, text) from public, anon;
grant execute on function public.book_term_class(uuid, text, uuid, text[], uuid[], text, text) to authenticated;

revoke all on function public.skip_term_class(uuid) from public, anon;
grant execute on function public.skip_term_class(uuid) to authenticated;

notify pgrst, 'reload schema';

commit;
