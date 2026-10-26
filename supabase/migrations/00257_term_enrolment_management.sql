-- 00257_term_enrolment_management.sql
--
-- (Written as 00244; renumbered 2026-10-26. Its search_activities now carries 00250's price range and
-- venue count as well as p_terms_only, so applying it cannot undo 00250.)
--
-- Running a term once families are in it (builds on 00256, written as 00243).
--
--   * Withdraw from a term: withdraw_from_term() for the parent,
--     vendor_withdraw_from_term() for the vendor. Only sessions still to come
--     (outside the cancellation window) are cancelled. What the family gets back
--     follows the app's existing cancellation rules (00099): the parent's path
--     uses the activity's refund setting; the vendor picks 'refund' or 'none'
--     with a reason. compensate_cancelled_booking does the rest, unchanged.
--     The refund rule for withdrawals is still to be decided; it lives only in
--     these two functions.
--   * A class the vendor cancels already gives each family a make-up token
--     (00154). Those tokens can now be redeemed on a term session: the gate
--     accepts a 'makeup' booking, which only redeem_make_up_token makes.
--   * Roster and numbers for the vendor: term_roster(), term_slot_stats().
--   * Re-enrolment: a term copied from another (terms.previous_term_id) can
--     open a 7-day priority window (open_reenrolment) during which only
--     families enrolled in the earlier term can enrol, trial or book singles.
--     Those families are notified (type 'term_reenrol_open').
--   * Sibling discount: terms.sibling_discount_pct, applied by enrol_in_term
--     to the second and later child a parent enrols in the same term.
--   * One confirmation for a term: notify_booking_confirmed sends
--     'term_enrolled' (with every date) instead of 'booking_confirmed' for the
--     seats of an enrolment.
--   * activities_with_live_terms() and search_activities(p_terms_only) for the
--     Explore "Terms" filter.
--
-- Idempotent.

begin;

-- =============================================================
-- 1. Columns
-- =============================================================
alter table public.terms
  add column if not exists sibling_discount_pct int not null default 0
    check (sibling_discount_pct between 0 and 100),
  add column if not exists previous_term_id uuid references public.terms (id) on delete set null,
  add column if not exists priority_until timestamptz;

-- A make-up token redeemed on a term session.
alter table public.bookings drop constraint if exists bookings_term_booking_kind_check;
alter table public.bookings
  add constraint bookings_term_booking_kind_check
    check (term_booking_kind is null or term_booking_kind in ('term', 'single', 'trial', 'package', 'makeup'));

-- =============================================================
-- 2. Was this parent a family on the earlier term?
-- =============================================================
create or replace function public.term_has_returning_family(p_prev_term uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (
    select 1
    from public.term_enrolments e
    join public.bookings b on b.term_enrolment_id = e.id
    where e.term_id = p_prev_term
      and e.user_id = p_user
      and b.status in ('confirmed', 'completed')
  );
$$;

-- =============================================================
-- 3. The booking gate: make-up bookings, re-enrolment priority
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
-- 4. Enrol: sibling discount, siblings in one checkout
-- =============================================================
-- p_group_id: enrol this child into a booking group the parent already holds
-- unpaid for the same term (their first child's), so all the children are paid
-- in one Stripe checkout and settled together by the existing webhook. The new
-- trailing parameter means the 00243 signature is dropped first (two would make
-- PostgREST calls ambiguous).
drop function if exists public.enrol_in_term(uuid, uuid, uuid[], text, text);
create or replace function public.enrol_in_term(
  p_slot_id   uuid,
  p_child_id  uuid default null,
  p_policies  uuid[] default '{}',
  p_medical   text default null,
  p_info      text default null,
  p_group_id  uuid default null
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
  v_price    int;
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
    if p_group_id is null or v_prev.booking_group_id = p_group_id then
      return query select v_prev.id, v_prev.booking_group_id, 'pending'::text, v_prev.price_cents, v_prev.sessions;
      return;
    end if;
    -- 00244: the child is being added to a sibling's checkout, but still holds
    -- an abandoned checkout of their own. Release it (unpaid, so nothing is
    -- owed back) and enrol them afresh into the shared group.
    update public.bookings
       set status = 'cancelled'
     where term_enrolment_id = v_prev.id and status = 'pending' and payment_status = 'none';
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

  -- 00244: sibling discount. The second and later child this parent enrols in
  -- the same term (any group) gets the vendor's sibling discount.
  v_price := v_quote.price_cents;
  if v_term.sibling_discount_pct > 0 and exists (
    select 1 from public.term_enrolments e
    join public.bookings b on b.term_enrolment_id = e.id
    where e.term_id = v_term.id and e.user_id = v_user
      and e.child_id is distinct from v_child
      and b.status in ('pending', 'confirmed')
  ) then
    v_price := round(v_price * (100 - v_term.sibling_discount_pct) / 100.0)::int;
  end if;

  v_group := gen_random_uuid();
  if p_group_id is not null then
    if not exists (
      select 1 from public.term_enrolments e
      join public.bookings b on b.term_enrolment_id = e.id
      where e.booking_group_id = p_group_id and e.user_id = v_user and e.term_id = v_term.id
        and b.status = 'pending' and b.payment_status = 'none'
    ) then
      raise exception 'That checkout has expired. Start the enrolment again.';
    end if;
    v_group := p_group_id;
  end if;
  insert into public.term_enrolments (term_id, slot_id, provider_id, user_id, child_id, price_cents, sessions, booking_group_id)
  values (v_term.id, p_slot_id, v_term.provider_id, v_user, v_child, v_price, array_length(v_ids, 1), v_group)
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

  return query select v_enrol, v_group, v_status, v_price, array_length(v_ids, 1);
end;
$$;

-- =============================================================
-- 5. Make-up tokens can be redeemed on a term session
-- =============================================================
-- Same as 00156, plus: on a term session the booking is stamped 'makeup' so
-- term_session_gate lets it through.
create or replace function public.redeem_make_up_token(
  p_token_id uuid,
  p_session_id uuid,
  p_policies uuid[] default '{}',
  p_medical text default null,
  p_info text default null
)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_user uuid := auth.uid();
  v_tok public.make_up_tokens;
  v_provider uuid;
  v_term_slot uuid;
  v_booking_id uuid;
  v_status text;
begin
  if v_user is null then
    raise exception 'Not authenticated';
  end if;

  -- Locked: two concurrent redemptions of the same token must not both pass
  -- this check before either commits its status update.
  select * into v_tok
  from public.make_up_tokens
  where id = p_token_id
    and user_id = v_user
    and status = 'issued'
    and (expires_at is null or expires_at > now())
  for update;
  if not found then
    raise exception 'This make-up token is not available';
  end if;

  select a.provider_id, s.term_slot_id into v_provider, v_term_slot
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  where s.id = p_session_id;
  if v_provider is null or v_provider <> v_tok.provider_id then
    raise exception 'This token can only be used for its provider''s classes';
  end if;

  if v_term_slot is not null then
    perform set_config('bb.term_booking_kind', 'makeup', true);
  end if;

  insert into public.bookings (user_id, session_id, child_id, policies_accepted, medical_disclosure, info_response)
  values (
    v_user, p_session_id, v_tok.child_id, coalesce(p_policies, '{}'::uuid[]),
    nullif(btrim(p_medical), ''), nullif(btrim(p_info), '')
  )
  returning id, status into v_booking_id, v_status;

  perform set_config('bb.term_booking_kind', '', true);

  if v_status = 'pending' then
    update public.bookings set status = 'confirmed' where id = v_booking_id;
    v_status := 'confirmed';
  end if;

  -- 00197 (kept here so this replacement cannot undo it): a full class puts
  -- the parent on the waitlist for free; the token stays unused for when they
  -- actually book.
  if v_status <> 'waitlisted' then
    update public.make_up_tokens
    set status = 'redeemed', redeemed_booking_id = v_booking_id
    where id = p_token_id;
  end if;

  return v_status;
end;
$function$;

-- =============================================================
-- 6. Withdraw from a term
-- =============================================================
-- Cancels the enrolment's sessions that are still to come and outside the
-- activity's cancellation window. Sessions already run, or too close to cancel,
-- are kept. Returns how many were cancelled.
create or replace function public.withdraw_from_term(p_enrolment_id uuid)
returns int
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_user  uuid := auth.uid();
  v_e     public.term_enrolments;
  v_allow boolean;
  v_cut   int;
  v_mode  text;
  v_n     int;
begin
  if v_user is null then raise exception 'Not authenticated'; end if;
  select * into v_e from public.term_enrolments where id = p_enrolment_id and user_id = v_user;
  if not found then raise exception 'That enrolment was not found.'; end if;

  select a.allow_cancellation, a.cancellation_cutoff_hours, a.cancellation_refund_mode
    into v_allow, v_cut, v_mode
  from public.terms t join public.activities a on a.id = t.activity_id
  where t.id = v_e.term_id;
  if not coalesce(v_allow, true) then
    raise exception 'The provider does not allow cancellations for this class. Contact them to withdraw.';
  end if;

  update public.bookings b
     set status = 'cancelled',
         cancel_refund_mode = coalesce(v_mode, 'refund')
    from public.activity_sessions s
   where s.id = b.session_id
     and b.term_enrolment_id = p_enrolment_id
     and b.user_id = v_user
     and b.status in ('pending', 'confirmed', 'waitlisted')
     and s.starts_at - make_interval(hours => coalesce(s.cancellation_cutoff_hours, v_cut, 0)) > now();
  get diagnostics v_n = row_count;
  if v_n = 0 then
    raise exception 'There are no sessions left that can still be cancelled.';
  end if;
  return v_n;
end;
$$;

-- The vendor's version: any session still to come, with the refund decision
-- made in the dialog (a 'none' needs a reason, as for any vendor cancel, 00099).
create or replace function public.vendor_withdraw_from_term(p_enrolment_id uuid, p_refund_mode text, p_reason text default null)
returns int
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_e public.term_enrolments;
  v_n int;
begin
  select * into v_e from public.term_enrolments where id = p_enrolment_id;
  if not found or v_e.provider_id not in (select public.user_manage_provider_ids()) then
    raise exception 'not authorized';
  end if;
  if p_refund_mode not in ('refund', 'none') then
    raise exception 'Choose refund or no refund.';
  end if;

  update public.bookings b
     set status = 'cancelled',
         cancel_refund_mode = p_refund_mode,
         cancel_reason = nullif(btrim(p_reason), ''),
         cancelled_by = auth.uid()
    from public.activity_sessions s
   where s.id = b.session_id
     and b.term_enrolment_id = p_enrolment_id
     and b.status in ('pending', 'confirmed', 'waitlisted')
     and s.starts_at > now();
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- =============================================================
-- 7. Vendor: who is on the term, and how full each group is
-- =============================================================
create or replace function public.term_roster(p_term_id uuid)
returns table (
  enrolment_id uuid,
  slot_id uuid,
  child_name text,
  child_dob date,
  parent_name text,
  parent_email text,
  price_cents int,
  sessions int,
  sessions_left int,
  joined_session_no int,
  paid boolean,
  status text,
  enrolled_at timestamptz
)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if not exists (select 1 from public.terms t where t.id = p_term_id and t.provider_id in (select public.user_provider_ids())) then
    raise exception 'not authorized';
  end if;
  return query
  select e.id,
         e.slot_id,
         coalesce(c.name, 'Child'),
         c.date_of_birth,
         nullif(btrim(pp.full_name), ''),
         pp.email,
         e.price_cents,
         e.sessions,
         (count(*) filter (where b.status in ('pending', 'confirmed') and s.starts_at > now()))::int,
         min(s.term_session_no),
         bool_and(b.payment_status = 'paid' or b.status = 'cancelled'),
         case
           when bool_or(b.status = 'confirmed') then 'enrolled'
           when bool_or(b.status = 'pending') then 'unpaid'
           else 'withdrawn'
         end,
         e.created_at
  from public.term_enrolments e
  join public.bookings b on b.term_enrolment_id = e.id
  join public.activity_sessions s on s.id = b.session_id
  left join public.children c on c.id = e.child_id
  left join public.parent_profiles pp on pp.id = e.user_id
  where e.term_id = p_term_id
  group by e.id, c.name, c.date_of_birth, pp.full_name, pp.email
  -- A checkout that was abandoned (every seat cancelled, none ever paid) is not
  -- a family on the term.
  having bool_or(b.status <> 'cancelled') or bool_or(b.payment_status = 'paid')
  order by e.created_at;
end;
$$;

create or replace function public.term_slot_stats(p_term_id uuid)
returns table (slot_id uuid, enrolled int, unpaid int, places_left int, one_off_bookings int, revenue_cents int)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if not exists (select 1 from public.terms t where t.id = p_term_id and t.provider_id in (select public.user_provider_ids())) then
    raise exception 'not authorized';
  end if;
  return query
  select ts.id,
         (select count(*)::int from public.term_enrolments e
           where e.slot_id = ts.id
             and exists (select 1 from public.bookings b where b.term_enrolment_id = e.id and b.status = 'confirmed')),
         (select count(*)::int from public.term_enrolments e
           where e.slot_id = ts.id
             and exists (select 1 from public.bookings b where b.term_enrolment_id = e.id and b.status = 'pending')
             and not exists (select 1 from public.bookings b where b.term_enrolment_id = e.id and b.status = 'confirmed')),
         -- The tightest upcoming session decides how many can still enrol.
         (select min(greatest(0, s.capacity - (select count(*) from public.bookings b
                                               where b.session_id = s.id and b.status in ('pending', 'confirmed'))))::int
            from public.activity_sessions s
           where s.term_slot_id = ts.id and s.starts_at > now() and s.status is distinct from 'cancelled'),
         (select count(*)::int from public.bookings b
            join public.activity_sessions s on s.id = b.session_id
           where s.term_slot_id = ts.id and b.term_booking_kind in ('single', 'trial', 'package', 'makeup')
             and b.status in ('pending', 'confirmed', 'completed')),
         (select coalesce(sum(e.price_cents), 0)::int from public.term_enrolments e
           where e.slot_id = ts.id
             and exists (select 1 from public.bookings b where b.term_enrolment_id = e.id and b.payment_status = 'paid'))
  from public.term_slots ts
  where ts.term_id = p_term_id
  order by ts.position;
end;
$$;

-- =============================================================
-- 8. Re-enrolment: open a 7-day priority window and tell the families
-- =============================================================
create or replace function public.open_reenrolment(p_term_id uuid, p_days int default 7)
returns int
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_t   public.terms;
  v_act text;
  v_n   int;
begin
  select * into v_t from public.terms where id = p_term_id;
  if not found or v_t.provider_id not in (select public.user_manage_provider_ids()) then
    raise exception 'not authorized';
  end if;
  if v_t.status <> 'published' then
    raise exception 'Publish the term first.';
  end if;
  if v_t.previous_term_id is null then
    raise exception 'This term was not copied from an earlier one.';
  end if;

  update public.terms
     set priority_until = now() + make_interval(days => greatest(1, least(30, p_days)))
   where id = p_term_id
  returning * into v_t;

  select a.title into v_act from public.activities a where a.id = v_t.activity_id;

  insert into public.notifications (user_id, type, title, body, data)
  select distinct e.user_id,
         'term_reenrol_open',
         'Re-enrol for ' || v_t.name,
         'Places for ' || v_act || ' are held for current families until '
           || to_char(v_t.priority_until at time zone 'Asia/Singapore', 'Dy DD Mon') || '.',
         jsonb_build_object(
           'url', '/book?slug=' || (select a.slug from public.activities a where a.id = v_t.activity_id),
           'activity_name', v_act,
           'term_name', v_t.name,
           'priority_until', to_char(v_t.priority_until at time zone 'Asia/Singapore', 'Dy DD Mon YYYY, HH12:MI AM'))
  from public.term_enrolments e
  join public.bookings b on b.term_enrolment_id = e.id
  where e.term_id = v_t.previous_term_id
    and b.status in ('confirmed', 'completed');
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- =============================================================
-- 9. One confirmation for a whole enrolment
-- =============================================================
-- As 00228, but the seats of a term enrolment send one 'term_enrolled'
-- notification listing every date, instead of 'booking_confirmed'.
create or replace function public.notify_booking_confirmed()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.user_id is not null
     and new.status = 'confirmed'
     and coalesce(old.status, '') <> 'confirmed' then
    if new.term_enrolment_id is not null then
      -- One per enrolment (several children can share a checkout group).
      if not exists (
        select 1 from public.bookings sib
        join public.notifications n on n.type = 'term_enrolled' and n.data ->> 'booking_id' = sib.id::text
        where sib.term_enrolment_id = new.term_enrolment_id and sib.id <> new.id
      ) then
        insert into public.notifications (user_id, type, title, body, data)
        select new.user_id, 'term_enrolled', 'Enrolled in ' || t.name || ' 🎉',
               coalesce(c.name, 'Your child') || ' is enrolled in ' || t.name || ' (' || a.title || ').',
               public.session_email_details(new.session_id) || jsonb_build_object(
                 'url', '/profile?tab=bookings',
                 'booking_id', new.id,
                 'term_name', t.name,
                 'child_name', c.name,
                 'enrolment_id', e.id,
                 'dates', (
                   select jsonb_agg(to_char(s2.starts_at at time zone 'Asia/Singapore', 'Dy DD Mon, HH12:MI AM') order by s2.starts_at)
                   from public.bookings b2
                   join public.activity_sessions s2 on s2.id = b2.session_id
                   where b2.term_enrolment_id = e.id and b2.status in ('pending', 'confirmed')),
                 -- For the email's one-tap "Add all to calendar" (/api/public/calendar?d=).
                 'sessions', (
                   select jsonb_agg(jsonb_build_object('s', s2.starts_at, 'e', s2.ends_at) order by s2.starts_at)
                   from public.bookings b2
                   join public.activity_sessions s2 on s2.id = b2.session_id
                   where b2.term_enrolment_id = e.id and b2.status in ('pending', 'confirmed')))
        from public.term_enrolments e
        join public.terms t on t.id = e.term_id
        join public.activities a on a.id = t.activity_id
        left join public.children c on c.id = e.child_id
        where e.id = new.term_enrolment_id;
      end if;
    elsif not public.group_sibling_notified(new.booking_group_id, new.id, 'booking_confirmed') then
      insert into public.notifications (user_id, type, title, body, data)
      select new.user_id, 'booking_confirmed', 'Booking confirmed 🎉',
             'Your booking for ' || a.title || ' is confirmed.',
             public.session_email_details(new.session_id) || jsonb_build_object(
               'url', '/profile?tab=bookings',
               'booking_id', new.id)
      from public.activity_sessions s
      join public.activities a on a.id = s.activity_id
      where s.id = new.session_id;
    end if;
  end if;
  return new;
end;
$function$;

-- =============================================================
-- 10. Explore: which activities have a term open
-- =============================================================
create or replace function public.activities_with_live_terms()
returns table (activity_id uuid)
language sql
stable
security definer
set search_path to 'public'
as $$
  select distinct t.activity_id
  from public.terms t
  join public.activities a on a.id = t.activity_id and a.terms_enabled
  where t.status = 'published'
    and exists (
      select 1 from public.term_slots ts
      join public.activity_sessions s on s.term_slot_id = ts.id
      where ts.term_id = t.id and s.status is distinct from 'cancelled' and s.starts_at > now()
    );
$$;

-- Explore search gets an optional p_terms_only (default null: unchanged). The
-- old 20-argument signature is dropped first; leaving both makes PostgREST
-- calls ambiguous (see 00220). The front end only sends p_terms_only when the
-- "Terms" filter is on.
drop function if exists public.search_activities(text,text,integer,date,double precision,double precision,double precision,text,integer,integer,text[],integer,integer,text[],numeric,date,date,integer,integer,text[]);
drop function if exists public.search_activities(text,text,integer,date,double precision,double precision,double precision,text,integer,integer,text[],integer,integer,text[],numeric,date,date,integer,integer,text[],boolean);

CREATE OR REPLACE FUNCTION public.search_activities(p_query text DEFAULT NULL::text, p_category_slug text DEFAULT NULL::text, p_age_months integer DEFAULT NULL::integer, p_date date DEFAULT NULL::date, p_lat double precision DEFAULT NULL::double precision, p_lng double precision DEFAULT NULL::double precision, p_radius_km double precision DEFAULT NULL::double precision, p_sort text DEFAULT 'popular'::text, p_limit integer DEFAULT 24, p_offset integer DEFAULT 0, p_categories text[] DEFAULT NULL::text[], p_age_min_months integer DEFAULT NULL::integer, p_age_max_months integer DEFAULT NULL::integer, p_regions text[] DEFAULT NULL::text[], p_max_price numeric DEFAULT NULL::numeric, p_date_from date DEFAULT NULL::date, p_date_to date DEFAULT NULL::date, p_time_min integer DEFAULT NULL::integer, p_time_max integer DEFAULT NULL::integer, p_region_order text[] DEFAULT NULL::text[], p_terms_only boolean DEFAULT NULL::boolean)
 RETURNS TABLE(id uuid, slug text, title text, category_slug text, category_name text, age_min_months integer, age_max_months integer, price numeric, image_urls text[], latitude double precision, longitude double precision, rating_avg numeric, rating_count integer, popularity integer, next_session_at timestamp with time zone, dist_km double precision, boosted boolean, provider_id uuid, provider_name text, address text, region text, duration_mins integer, instant_book boolean, image_source text, cover_image_url text, provider_logo_url text, provider_cover_image_url text, provider_gallery_urls text[], is_course boolean, run_starts_at timestamp with time zone, run_ends_at timestamp with time zone, category_2_slug text, category_2_name text, areas text[], venues jsonb, total_count bigint, is_custom_location boolean, custom_location_label text, price_from numeric, price_to numeric, location_count integer)
 LANGUAGE sql
 STABLE
AS $function$
  with m as (
    select *
    from public.matching_activities(
      p_query := p_query, p_category_slug := p_category_slug, p_categories := p_categories,
      p_age_months := p_age_months, p_age_min_months := p_age_min_months, p_age_max_months := p_age_max_months,
      p_date := p_date, p_date_from := p_date_from, p_date_to := p_date_to,
      p_time_min := p_time_min, p_time_max := p_time_max,
      p_regions := p_regions, p_max_price := p_max_price,
      p_lat := p_lat, p_lng := p_lng, p_radius_km := p_radius_km
    )
  ),
  -- Price range and venue count from activity_locations only (same reasoning
  -- as matching_activities' prc: no session scan on the catalogue path).
  r as (
    select m.*, prc.lo as price_from, prc.hi as price_to, greatest(1, coalesce(locs.n, 0))::int as location_count
    from m
    left join lateral (
      select min(z.v) as lo, max(z.v) as hi
      from (
        select m.price as v
        union all
        select coalesce(al.price, m.price) from public.activity_locations al where al.activity_id = m.id
        union all
        select (d.value #>> '{}')::numeric
        from public.activity_locations al, jsonb_each(al.day_prices) d
        where al.activity_id = m.id
      ) z
    ) prc on true
    left join lateral (
      select count(*) as n from public.activity_locations al where al.activity_id = m.id
    ) locs on true
  )
  select
    id, slug, title, category_slug, category_name,
    age_min_months, age_max_months, price, image_urls,
    latitude, longitude, rating_avg, rating_count, popularity, next_session_at,
    dist_km, boosted, provider_id, provider_name, address, region, duration_mins, instant_book,
    image_source, cover_image_url, provider_logo_url, provider_cover_image_url, provider_gallery_urls,
    is_course, run_starts_at, run_ends_at, category_2_slug, category_2_name,
    areas, venues,
    count(*) over() as total_count,
    is_custom_location,
    custom_location_label,
    price_from,
    price_to,
    location_count
  from r
  -- 00244: the Explore Terms filter - only activities with a term open.
  where p_terms_only is not true
     or id in (select tt.activity_id from public.activities_with_live_terms() tt)
  order by
    text_hit desc,
    case when p_sort = 'soonest' then next_session_at end asc nulls last,
    case when p_sort = 'distance' and p_lat is not null and p_region_order is not null
         then (select min(array_position(p_region_order, rr)) from unnest(areas) rr) end asc nulls last,
    case when p_sort = 'distance' and p_lat is not null
         then coalesce(
                (select min(public.distance_km(p_lat, p_lng, (v->>'lat')::float8, (v->>'lng')::float8))
                   from jsonb_array_elements(venues) v),
                dist_km) end asc nulls last,
    case when p_sort = 'rating' then rating_avg end desc nulls last,
    case when p_sort = 'price_asc' then coalesce(price_from, price) end asc nulls last,
    case when p_sort = 'price_desc' then coalesce(price_from, price) end desc nulls last,
    instant_book desc,
    boosted desc,
    popularity desc,
    created_at desc,
    id
  limit p_limit offset p_offset;
$function$
;

grant execute on function public.search_activities(text,text,integer,date,double precision,double precision,double precision,text,integer,integer,text[],integer,integer,text[],numeric,date,date,integer,integer,text[],boolean) to anon, authenticated, service_role;


-- =============================================================
-- 11. Who may call what
-- =============================================================
revoke all on function public.term_has_returning_family(uuid, uuid) from public, anon, authenticated;
revoke all on function public.enrol_in_term(uuid, uuid, uuid[], text, text, uuid) from public, anon;
grant execute on function public.enrol_in_term(uuid, uuid, uuid[], text, text, uuid) to authenticated;
revoke all on function public.withdraw_from_term(uuid) from public, anon;
grant execute on function public.withdraw_from_term(uuid) to authenticated;
revoke all on function public.vendor_withdraw_from_term(uuid, text, text) from public, anon;
grant execute on function public.vendor_withdraw_from_term(uuid, text, text) to authenticated;
revoke all on function public.term_roster(uuid) from public, anon;
grant execute on function public.term_roster(uuid) to authenticated;
revoke all on function public.term_slot_stats(uuid) from public, anon;
grant execute on function public.term_slot_stats(uuid) to authenticated;
revoke all on function public.open_reenrolment(uuid, int) from public, anon;
grant execute on function public.open_reenrolment(uuid, int) to authenticated;
revoke all on function public.activities_with_live_terms() from public;
grant execute on function public.activities_with_live_terms() to anon, authenticated;
revoke all on function public.redeem_make_up_token(uuid, uuid, uuid[], text, text) from public, anon;
grant execute on function public.redeem_make_up_token(uuid, uuid, uuid[], text, text) to authenticated;

notify pgrst, 'reload schema';

commit;
