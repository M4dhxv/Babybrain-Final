-- 00276_term_group_offers.sql
--
-- Price, offers and booking policies belong to each GROUP (a term slot: one weekly day/time/venue),
-- not to the whole term or the activity, and the vendor no longer switches "terms" on for an activity.
--
-- Per group (term_slots), all optional (null = follow the term, then the activity):
--
--   offer_term                    the whole term can be enrolled in (default true)
--   offer_single / offer_trial    single sessions / a trial session can be booked on this group
--   offer_package                 package credits can be spent on this group's sessions
--   single_price_cents / trial_price_cents
--                                 what a single / trial session of THIS group costs
--   allow_cancellation, cancellation_cutoff_hours, cancellation_refund_mode, allow_rescheduling,
--   reschedule_cutoff_hours, booking_cutoff_minutes
--                                 the group's booking policy. It is stamped onto the group's sessions
--                                 (activity_sessions already carries these per session), so it applies
--                                 through the same code as any other session's policy.
--
-- The term's own flags (allow_singles, allow_trial, allow_packages and the prices) stay as the OUTER
-- bound and the default a group inherits: the vendor portal writes each as "some group offers it". The
-- booking gate (term_session_gate) now asks the group, so a group that does not offer a way in refuses it.
--
-- Rules, enforced here and not only in the portal (guard_term_slot_offers):
--   * a group must offer at least one way in: the term, single sessions, a trial or packages;
--   * a trial needs the term or single sessions on, so a child is not stranded after it;
--   * enrolment cannot be turned off for a group that families are enrolled in.
--
-- And: creating a term switches the activity's terms on by itself (activities.terms_enabled is kept, as
-- the database's own marker, but the vendor never sees a switch). Not on a monthly-billing activity.
--
-- Older terms and older portal code are untouched: every new column is null / true, so a group behaves
-- exactly as it did.
--
-- Idempotent.

begin;

-- =============================================================
-- 1. Per-group columns
-- =============================================================
alter table public.term_slots
  add column if not exists offer_term boolean not null default true,
  add column if not exists offer_single boolean,
  add column if not exists offer_trial boolean,
  add column if not exists offer_package boolean,
  add column if not exists single_price_cents int,
  add column if not exists trial_price_cents int,
  add column if not exists allow_cancellation boolean,
  add column if not exists cancellation_cutoff_hours int,
  add column if not exists cancellation_refund_mode text,
  add column if not exists allow_rescheduling boolean,
  add column if not exists reschedule_cutoff_hours int,
  add column if not exists booking_cutoff_minutes int;

alter table public.term_slots drop constraint if exists term_slots_group_offer_values;
alter table public.term_slots
  add constraint term_slots_group_offer_values check (
    (single_price_cents is null or single_price_cents >= 0)
    and (trial_price_cents is null or trial_price_cents >= 0)
    and (cancellation_cutoff_hours is null or cancellation_cutoff_hours >= 0)
    and (reschedule_cutoff_hours is null or reschedule_cutoff_hours >= 0)
    and (booking_cutoff_minutes is null or booking_cutoff_minutes >= 0)
    and (cancellation_refund_mode is null or cancellation_refund_mode in ('refund', 'none'))
  );

-- =============================================================
-- 2. What a group effectively offers (its own value, else the term's)
-- =============================================================
create or replace function public.term_slot_offer(p_slot_id uuid)
returns table (
  offer_term         boolean,
  offer_single       boolean,
  offer_trial        boolean,
  offer_package      boolean,
  single_price_cents int,
  trial_price_cents  int
)
language sql
stable
security definer
set search_path to 'public'
as $$
  select s.offer_term,
         coalesce(s.offer_single, t.allow_singles),
         coalesce(s.offer_trial, t.allow_trial),
         coalesce(s.offer_package, t.allow_packages),
         coalesce(s.single_price_cents, t.single_price_cents),
         coalesce(s.trial_price_cents, t.trial_price_cents)
  from public.term_slots s
  join public.terms t on t.id = s.term_id
  where s.id = p_slot_id;
$$;

-- =============================================================
-- 3. The rules a group's offers must satisfy
-- =============================================================
create or replace function public.guard_term_slot_offers()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_t      public.terms;
  v_single boolean;
  v_trial  boolean;
  v_pack   boolean;
begin
  select * into v_t from public.terms where id = new.term_id;
  v_single := coalesce(new.offer_single, v_t.allow_singles);
  v_trial  := coalesce(new.offer_trial, v_t.allow_trial);
  v_pack   := coalesce(new.offer_package, v_t.allow_packages);

  if not (new.offer_term or v_single or v_trial or v_pack) then
    raise exception 'A group has to offer at least one way in: the whole term, single sessions, a trial or package credits.';
  end if;
  if v_trial and not (new.offer_term or v_single) then
    raise exception 'A trial needs the whole term or single sessions switched on too, so a child is not left with nowhere to go after it.';
  end if;

  if tg_op = 'UPDATE' and old.offer_term and not new.offer_term and exists (
    select 1
    from public.term_enrolments e
    join public.bookings b on b.term_enrolment_id = e.id
    where e.slot_id = new.id and b.status in ('pending', 'confirmed')
  ) then
    raise exception 'Families are enrolled in this group, so enrolment can''t be turned off for it. Let the term finish first.';
  end if;
  return new;
end;
$$;

drop trigger if exists term_slot_offers_guard on public.term_slots;
create trigger term_slot_offers_guard before insert or update on public.term_slots
  for each row execute function public.guard_term_slot_offers();

-- =============================================================
-- 4. The booking gate, per group
-- =============================================================
-- term_session_gate (00256/00257/00259) with every "does the term offer this?" question asked of the
-- group instead (term_slot_offer: the group's own setting, else the term's). Nothing else in it changes.
-- In particular the trial-first rule is the group's: a group that offers no trial never asks for one.
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
  v_used    int;
  v_o       record;
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
  -- 00276: what THIS group offers (its own setting, else the term's).
  select * into v_o from public.term_slot_offer(v_slot_id);
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
      if not v_o.offer_package then
        raise exception 'This group does not accept package credits.';
      end if;
      v_kind := 'package';
    else
      raise exception 'This session is part of a term. Enrol in the term, or book a trial or single session from the term page.';
    end if;
  end if;

  if v_kind = 'term' then
    if not v_o.offer_term then
      raise exception 'Enrolling for the whole term is not offered for this group.';
    end if;
    v_enrol := nullif(current_setting('bb.term_enrolment_id', true), '')::uuid;
  elsif v_kind in ('single', 'trial') then
    if v_kind = 'single' and not v_o.offer_single then
      raise exception 'Single sessions are not offered for this group.';
    end if;
    if v_kind = 'trial' and not v_o.offer_trial then
      raise exception 'There is no trial session for this group.';
    end if;
    -- 00259: the single places are used up, though the session may still have
    -- seats for term families. The parent waits for a single place, the same
    -- as for a full session.
    if new.status is distinct from 'waitlisted' and public.term_single_places_full(new.session_id) then
      new.status := 'waitlisted';
      select coalesce(max(b.waitlist_position), 0) + 1 into new.waitlist_position
      from public.bookings b where b.session_id = new.session_id and b.status = 'waitlisted';
    end if;
    -- One waitlist place per child per session: a second would only send the
    -- same "a spot is available" email twice.
    if new.status = 'waitlisted' and new.child_id is not null and exists (
      select 1 from public.bookings b
      where b.session_id = new.session_id
        and b.status = 'waitlisted'
        and b.child_id = new.child_id
    ) then
      raise exception 'This child is already on the waitlist for this session.';
    end if;
    -- Trials are counted for a trial booking, and for a single booking on a
    -- term that has a trial: for now a single session is only offered once
    -- the child has used their trial (the booking page hides it until then).
    if v_kind = 'trial' or (v_kind = 'single' and v_o.offer_trial) then
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
  elsif v_kind not in ('package', 'makeup') then
    raise exception 'That booking type is not available for this session.';
  end if;
  -- 00244: re-enrolment priority. While a copied term's priority window is
  -- open, only families enrolled in the term it was copied from can take a
  -- place (enrolment, trial or single). Package and make-up bookings are a
  -- family's own credit, so they are not held back.
  if v_kind in ('term', 'single', 'trial')
     and v_term.priority_until is not null and v_term.priority_until > now()
     and v_term.previous_term_id is not null
     and not public.term_has_returning_family(v_term.previous_term_id, new.user_id) then
    raise exception 'Re-enrolment for current families is open until %. Enrolment opens to everyone after that.',
      to_char(v_term.priority_until at time zone 'Asia/Singapore', 'Dy DD Mon, HH12:MI AM');
  end if;

  new.term_booking_kind := v_kind;
  new.term_enrolment_id := v_enrol;
  return new;
end;
$$;

-- =============================================================
-- 5. A group's booking policy follows onto its sessions
-- =============================================================
-- New sessions (publish_term inserts them) take the group's policy where they have none of their own.
create or replace function public.term_slot_policy_defaults()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v public.term_slots;
begin
  if new.term_slot_id is null then
    return new;
  end if;
  select * into v from public.term_slots where id = new.term_slot_id;
  if not found then
    return new;
  end if;
  new.allow_cancellation        := coalesce(new.allow_cancellation, v.allow_cancellation);
  new.cancellation_cutoff_hours := coalesce(new.cancellation_cutoff_hours, v.cancellation_cutoff_hours);
  new.cancellation_refund_mode  := coalesce(new.cancellation_refund_mode, v.cancellation_refund_mode);
  new.allow_rescheduling        := coalesce(new.allow_rescheduling, v.allow_rescheduling);
  new.reschedule_cutoff_hours   := coalesce(new.reschedule_cutoff_hours, v.reschedule_cutoff_hours);
  new.booking_cutoff_minutes    := coalesce(new.booking_cutoff_minutes, v.booking_cutoff_minutes);
  return new;
end;
$$;

drop trigger if exists term_slot_policy_defaults on public.activity_sessions;
create trigger term_slot_policy_defaults before insert on public.activity_sessions
  for each row execute function public.term_slot_policy_defaults();

-- Changing a group's policy updates the sessions still to come (a null puts them back to inheriting).
create or replace function public.term_slot_policy_follow()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  update public.activity_sessions
     set allow_cancellation        = new.allow_cancellation,
         cancellation_cutoff_hours = new.cancellation_cutoff_hours,
         cancellation_refund_mode  = new.cancellation_refund_mode,
         allow_rescheduling        = new.allow_rescheduling,
         reschedule_cutoff_hours   = new.reschedule_cutoff_hours,
         booking_cutoff_minutes    = new.booking_cutoff_minutes
   where term_slot_id = new.id and starts_at > now() and status is distinct from 'cancelled';
  return new;
end;
$$;

drop trigger if exists term_slot_policy_follow on public.term_slots;
create trigger term_slot_policy_follow after update of
    allow_cancellation, cancellation_cutoff_hours, cancellation_refund_mode,
    allow_rescheduling, reschedule_cutoff_hours, booking_cutoff_minutes
  on public.term_slots
  for each row execute function public.term_slot_policy_follow();

-- =============================================================
-- 6. Terms switch themselves on for an activity
-- =============================================================
create or replace function public.term_enable_activity()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_monthly text;
begin
  select to_jsonb(a) ->> 'monthly_billing_enabled' into v_monthly from public.activities a where a.id = new.activity_id;
  if coalesce(v_monthly, 'false') = 'true' then
    raise exception 'This activity bills monthly. Turn monthly billing off for it before creating a term.';
  end if;
  update public.activities set terms_enabled = true where id = new.activity_id and not terms_enabled;
  return new;
end;
$$;

drop trigger if exists term_enable_activity on public.terms;
create trigger term_enable_activity before insert on public.terms
  for each row execute function public.term_enable_activity();

-- Activities that already have a term (a draft with the switch still off) get it now, except monthly ones.
do $$
begin
  update public.activities a
     set terms_enabled = true
   where not a.terms_enabled
     and exists (select 1 from public.terms t where t.activity_id = a.id and t.status <> 'archived')
     and coalesce(to_jsonb(a) ->> 'monthly_billing_enabled', 'false') <> 'true';
end $$;

-- =============================================================
-- 7. What Explore and the activity page lead with, and whether packs make sense, per group
-- =============================================================
-- term_headline_prices (00256): trial price if any group offers a trial, else the single price if any
-- offers singles, else the lowest term price; now read from each group's own offers and prices.
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
           coalesce(ts.price_cents, t.price_cents) as term_price_cents
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

-- activity_packages_closed (00256): closed when the activity has live groups and none of them accepts packs.
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
  join public.term_slots ts on ts.term_id = t.id
  cross join lateral public.term_slot_offer(ts.id) o
  where t.activity_id = any (p_activity_ids)
    and t.status = 'published'
    and exists (
      select 1 from public.activity_sessions s
      where s.term_slot_id = ts.id and s.status is distinct from 'cancelled' and s.starts_at > now()
    )
  group by t.activity_id
  having not bool_or(o.offer_package);
$$;

-- =============================================================
-- 8. Who may call what
-- =============================================================
revoke all on function public.guard_term_slot_offers() from public, anon, authenticated;
revoke all on function public.term_slot_policy_defaults() from public, anon, authenticated;
revoke all on function public.term_slot_policy_follow() from public, anon, authenticated;
revoke all on function public.term_enable_activity() from public, anon, authenticated;

revoke all on function public.term_slot_offer(uuid) from public;
grant execute on function public.term_slot_offer(uuid) to anon, authenticated;

revoke all on function public.term_headline_prices(uuid[]) from public;
grant execute on function public.term_headline_prices(uuid[]) to anon, authenticated;
revoke all on function public.activity_packages_closed(uuid[]) from public;
grant execute on function public.activity_packages_closed(uuid[]) to anon, authenticated;

notify pgrst, 'reload schema';

commit;
