-- 00278_term_early_price_and_cancel_guard.sql
--
-- Two requests from the client sheet (Terms, rows 20 and 25):
--
--   25  A term can carry an EARLY PRICE that runs until a date, so a vendor can offer a discount to families who
--       enrol in time. terms.early_price_cents is the price a family pays for the term while it runs;
--       terms.early_price_until is the last day it runs (the whole of that day, Singapore time).
--       The discount (price - early price) comes off whatever the family would otherwise pay, so a slot that
--       carries its own price keeps its difference. After the date the term's normal price applies again, and
--       the mid-term reduction counts as before. The price a family was quoted when they started enrolling is
--       the one stamped on their enrolment, so a checkout that straddles midnight still honours it.
--       Opt-in: with no early price set, nothing changes.
--       term_quote, term_combo_quote and term_headline_prices are the ONLY places a term price is worked out
--       (enrol_in_term_core and the waitlist offers read them), so only they change.
--
--   20  A parent can no longer cancel a term enrolment's sessions online once the term has started. The vendor
--       (and trusted server code) still can, from the Bookings page, and chooses there whether the family gets a
--       make-up token; the vendor can also move a family to another session (vendor_reschedule_booking, 00249).
--       Re-scheduling a term session online was already refused (00263). This covers CANCEL for the enrolment's
--       own sessions (term_booking_kind 'term'): single and trial sessions bought on top, and unpaid seats, follow
--       the activity's own cancellation rules as before. A trigger rather than a new cancel_booking, so
--       cancel_booking, cancel_booking_group and a direct update are all covered without copying their bodies.
--
-- The three pricing functions below are the newest definitions of 00256 (term_quote), 00264 (term_combo_quote)
-- and 00275 (term_headline_prices). If one is changed again, put the change in a NEW migration above this one.
--
-- Idempotent.

begin;

-- =============================================================
-- 1. Early price (row 25)
-- =============================================================
alter table public.terms add column if not exists early_price_cents int;
alter table public.terms add column if not exists early_price_until date;

alter table public.terms drop constraint if exists terms_early_price_complete;
alter table public.terms add constraint terms_early_price_complete
  check ((early_price_cents is null) = (early_price_until is null));
alter table public.terms drop constraint if exists terms_early_price_below_price;
alter table public.terms add constraint terms_early_price_below_price
  check (early_price_cents is null or (early_price_cents >= 0 and early_price_cents < price_cents));

-- What the early price takes off right now, in cents; 0 when there is none or its last day has passed.
create or replace function public.term_early_discount(p_term_id uuid)
returns int
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce((
    select greatest(0, t.price_cents - t.early_price_cents)
    from public.terms t
    where t.id = p_term_id
      and t.early_price_cents is not null
      and t.early_price_until is not null
      and now() < ((t.early_price_until + 1)::timestamp at time zone 'Asia/Singapore')
  ), 0);
$$;

-- ---- term_quote (00256), with the early discount
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
  -- 00278: an early price takes its discount off the base until its last day.
  v_base := greatest(0, coalesce(v_slot.price_cents, v_term.price_cents) - public.term_early_discount(v_term.id));
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

-- ---- term_combo_quote (00264), with the early discount
create or replace function public.term_combo_quote(p_slot_ids uuid[])
returns table (
  sessions_total  int,
  sessions_passed int,
  sessions_left   int,
  joinable        boolean,
  price_cents     int,
  reason          text
)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
#variable_conflict use_column
declare
  v_term   public.terms;
  v_groups int;
  v_slot   uuid;
  v_q      record;
  v_total  int := 0;
  v_passed int := 0;
  v_left   int := 0;
  v_ok     boolean := true;
  v_reason text;
  v_base   int;
  v_price  int;
begin
  select t.* into v_term from public.terms t where t.id = public.term_combo_check(p_slot_ids);
  select count(*)::int into v_groups from public.term_slot_groups g where g.term_id = v_term.id;
  foreach v_slot in array p_slot_ids loop
    select * into v_q from public.term_quote(v_slot);
    v_total := v_total + v_q.sessions_total;
    v_passed := v_passed + v_q.sessions_passed;
    v_left := v_left + v_q.sessions_left;
    if not v_q.joinable and v_ok then
      v_ok := false;
      v_reason := v_q.reason;
    end if;
  end loop;
  v_base := case when v_groups = 1
                 then coalesce((select ts.price_cents from public.term_slots ts where ts.id = p_slot_ids[1]), v_term.price_cents)
                 else v_term.price_cents end;
  -- 00278: an early price takes its discount off the base until its last day.
  v_base := greatest(0, v_base - public.term_early_discount(v_term.id));
  v_price := case when v_term.reduce_enabled
                  then greatest(0, v_base - v_term.reduce_by_cents * v_passed)
                  else v_base end;
  return query select v_total, v_passed, v_left, v_ok, v_price, v_reason;
end;
$$;

-- ---- term_headline_prices (00275), with the early discount
create or replace function public.term_headline_prices(p_activity_ids uuid[])
returns table (activity_id uuid, kind text, price_cents int)
language sql
stable
security definer
set search_path to 'public'
as $$
  with live as (
    select t.activity_id,
           o.offer_term, o.offer_single, o.offer_trial,
           o.single_price_cents, o.trial_price_cents,
           -- 00278: while an early price is running, the headline term price is the early one.
           greatest(0, coalesce(ts.price_cents, t.price_cents) - public.term_early_discount(t.id)) as term_price_cents
    from public.terms t
    join public.activities a on a.id = t.activity_id and a.terms_enabled
    join public.term_slots ts on ts.term_id = t.id
    cross join lateral public.term_slot_offer(ts.id) o
    where t.activity_id = any (p_activity_ids)
      and t.status = 'published'
      and exists (
        select 1 from public.activity_sessions s
        where s.term_slot_id = ts.id and s.status is distinct from 'cancelled' and s.starts_at > now()
      )
  ),
  agg as (
    select l.activity_id,
           min(l.trial_price_cents)  filter (where l.offer_trial)  as trial_cents,
           min(l.single_price_cents) filter (where l.offer_single) as single_cents,
           min(l.term_price_cents)   filter (where l.offer_term)   as term_cents
    from live l
    group by l.activity_id
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
-- 2. A parent cannot cancel an enrolment's sessions once the term has started (row 20)
-- =============================================================
-- Which of these sessions belong to a term that has started: any session of the term has passed its booking
-- window (the same moment term_quote counts a session as run). Internal: server code and the guard below only.
create or replace function public.term_sessions_started(p_session_ids uuid[])
returns table (session_id uuid)
language sql
stable
security definer
set search_path to 'public'
as $$
  select s.id
  from public.activity_sessions s
  join public.term_slots ts on ts.id = s.term_slot_id
  join public.activities a on a.id = s.activity_id
  where s.id = any (p_session_ids)
    and exists (
      select 1
      from public.term_slots ts2
      join public.activity_sessions s2 on s2.term_slot_id = ts2.id
      where ts2.term_id = ts.term_id
        and s2.status is distinct from 'cancelled'
        and s2.starts_at - make_interval(mins => coalesce(s2.booking_cutoff_minutes, a.booking_cutoff_minutes, 15)) <= now()
    );
$$;

create or replace function public.term_booking_cancel_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  -- Only the family themselves are held back; the vendor, an admin through the service role and the
  -- database's own jobs (no signed-in user) are not.
  if coalesce(auth.role(), '') = 'service_role' or auth.uid() is null or auth.uid() is distinct from old.user_id then
    return new;
  end if;
  if exists (select 1 from public.activity_sessions s
             join public.activities a on a.id = s.activity_id
             where s.id = old.session_id
               and a.provider_id in (select public.user_manage_provider_ids())) then
    return new;
  end if;
  if exists (select 1 from public.term_sessions_started(array[old.session_id])) then
    raise exception 'This term has started, so its sessions can''t be cancelled online. Contact the provider if you need to miss a session.';
  end if;
  return new;
end;
$$;

drop trigger if exists term_booking_cancel_guard on public.bookings;
create trigger term_booking_cancel_guard before update of status on public.bookings
  for each row
  when (old.term_booking_kind = 'term' and old.status = 'confirmed' and new.status = 'cancelled')
  execute function public.term_booking_cancel_guard();

-- =============================================================
-- Grants
-- =============================================================
revoke all on function public.term_early_discount(uuid) from public, anon, authenticated;
revoke all on function public.term_sessions_started(uuid[]) from public, anon, authenticated;
grant execute on function public.term_sessions_started(uuid[]) to service_role;
revoke all on function public.term_booking_cancel_guard() from public, anon, authenticated;

revoke all on function public.term_quote(uuid) from public;
grant execute on function public.term_quote(uuid) to anon, authenticated;
revoke all on function public.term_combo_quote(uuid[]) from public;
grant execute on function public.term_combo_quote(uuid[]) to anon, authenticated;
revoke all on function public.term_headline_prices(uuid[]) from public;
grant execute on function public.term_headline_prices(uuid[]) to anon, authenticated;

commit;
