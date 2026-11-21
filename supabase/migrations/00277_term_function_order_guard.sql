-- 00277_term_function_order_guard.sql
--
-- Two term functions are defined in more than one migration, and `create or replace` keeps whichever ran LAST:
--
--   withdraw_from_term   00257, 00260, 00263, 00264, and the newest: 00274 (withdrawal policy and credit)
--   term_session_gate    00256, 00257, 00259, and the newest: 00275 (offers per group)
--
-- Production received 00274 and 00275 (17 Nov 2026) BEFORE 00259-00264 and 00269, which were being held back.
-- Applying those older files afterwards would silently put the old withdraw_from_term and term_session_gate back
-- and undo the withdrawal policy and the per-group offers, with no error.
--
-- This migration sits after all of them and sets both functions to their newest definitions. Whatever order the
-- earlier files land in, the database ends with these. Applying it when they are already the newest is a no-op.
--
-- The bodies below are copied unchanged from 00274 and 00275. If either function is changed again, change it in
-- a NEW migration numbered above this one (editing 00274 / 00275 alone would not protect an out-of-order apply).
--
-- Needs 00264 (term slot groups) and 00269 applied: the withdrawal function reads term_enrolments.combo_id and
-- calls offer_term_place, and the gate reads the group offers from 00275.

begin;

-- ---------------------------------------------------------------------------
-- withdraw_from_term (from 00274)
-- ---------------------------------------------------------------------------
create or replace function public.withdraw_from_term(p_enrolment_id uuid)
returns int
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_user    uuid := auth.uid();
  v_e       public.term_enrolments;
  v_term    public.terms;
  v_ids     uuid[];
  v_slots   uuid[];
  v_allow   boolean;
  v_cut     int;
  v_mode    text;
  v_started boolean;
  v_n       int;
  v_slot    uuid;
  v_eid     uuid;
  v_grp     uuid;
  v_paid    int;
  v_spent   int;
  v_share   int;
  v_credit  int;
  v_cid     uuid;
  v_wid     uuid;
  v_status  text;
  v_title   text;
begin
  if v_user is null then raise exception 'Not authenticated'; end if;
  select * into v_e from public.term_enrolments where id = p_enrolment_id and user_id = v_user;
  if not found then raise exception 'That enrolment was not found.'; end if;

  -- 00264: a combination is withdrawn whole (a parent cannot drop one slot).
  select array_agg(e.id), array_agg(e.slot_id) into v_ids, v_slots
  from public.term_enrolments e
  where e.user_id = v_user
    and (e.id = p_enrolment_id or (v_e.combo_id is not null and e.combo_id = v_e.combo_id));

  select t.* into v_term from public.terms t where t.id = v_e.term_id;

  -- Started = a session of the group has passed its booking window (the
  -- moment term_quote counts it as run).
  select coalesce(bool_or((select q.sessions_passed > 0 from public.term_quote(x) q)), false)
    into v_started from unnest(v_slots) x;

  if v_term.withdraw_allowed is not null then
    -- ---- 00274: the vendor's policy for this term
    if not v_term.withdraw_allowed then
      raise exception 'The provider does not allow withdrawals from this term. Contact them to withdraw.';
    end if;
    if v_started then
      raise exception 'This term has started, so it can no longer be withdrawn online. Contact the provider.';
    end if;

    select a.title into v_title from public.activities a where a.id = v_term.activity_id;

    foreach v_eid in array v_ids loop
      -- What this enrolment paid in cash, and its share of any credit spent on the checkout.
      select coalesce(sum(round(b.amount * 100)), 0)::int into v_paid
      from public.bookings b
      where b.term_enrolment_id = v_eid and b.user_id = v_user
        and b.payment_status = 'paid' and b.status in ('pending', 'confirmed');

      select e.booking_group_id into v_grp from public.term_enrolments e where e.id = v_eid;
      select coalesce(sum(h.amount_cents), 0)::int into v_spent
      from public.term_credit_holds h where h.group_id = v_grp and h.status = 'spent';
      select case when sum(e.price_cents) > 0
                  then round(v_spent * (select e2.price_cents from public.term_enrolments e2 where e2.id = v_eid)::numeric / sum(e.price_cents))::int
                  else 0 end
        into v_share
      from public.term_enrolments e where e.booking_group_id = v_grp;

      v_credit := case v_term.withdraw_refund_mode
                    when 'credit' then v_paid + coalesce(v_share, 0)
                    when 'money'  then coalesce(v_share, 0)   -- credit already spent comes back as credit, never as cash
                    else 0 end;
      v_cid := null;
      if v_credit > 0 then
        insert into public.term_credits (provider_id, user_id, amount_cents, remaining_cents, expires_at)
        values (v_term.provider_id, v_user, v_credit, v_credit,
                now() + make_interval(days => coalesce(v_term.credit_valid_days, 365)))
        returning id into v_cid;
      end if;

      v_status := case
                    when v_paid = 0 and coalesce(v_share, 0) = 0 then 'nothing_paid'
                    when v_term.withdraw_refund_mode = 'money' and v_paid > 0 then 'refund_due'
                    when v_credit > 0 then 'credit_issued'
                    else 'no_refund' end;

      insert into public.term_withdrawals
        (enrolment_id, term_id, provider_id, user_id, child_id, outcome, paid_cents, credit_cents, credit_id, status)
      values
        (v_eid, v_term.id, v_term.provider_id, v_user, (select e.child_id from public.term_enrolments e where e.id = v_eid),
         v_term.withdraw_refund_mode, v_paid, v_credit, v_cid, v_status)
      returning id into v_wid;
      if v_cid is not null then
        update public.term_credits set source_withdrawal_id = v_wid where id = v_cid;
      end if;

      insert into public.notifications (user_id, type, title, body, data)
      values (
        v_user, 'term_withdrawn', 'You have withdrawn from ' || coalesce(v_title, 'the term'),
        case v_status
          when 'refund_due' then 'Your refund (what you paid less the payment processing fee) will be processed by hand.'
          when 'credit_issued' then 'You have a credit with the provider for another term.'
          when 'no_refund' then 'This term is non-refundable, so there is nothing to refund.'
          else 'Nothing had been paid, so there is nothing to refund.' end,
        jsonb_build_object('withdrawal_id', v_wid, 'status', v_status, 'term_name', v_term.name,
                           'activity_title', v_title, 'paid_cents', v_paid, 'credit_cents', v_credit,
                           'credit_days', v_term.credit_valid_days)
      );
    end loop;

    -- No cancellation window here: the policy is "before the term starts", so every
    -- session still to come goes. No make-up token either (cancel_refund_mode 'none'):
    -- the outcome above is the whole remedy.
    update public.bookings b
       set status = 'cancelled',
           cancel_refund_mode = 'none',
           cancel_reason = 'Withdrew before the term started'
      from public.activity_sessions s
     where s.id = b.session_id
       and b.term_enrolment_id = any (v_ids)
       and b.user_id = v_user
       and b.status in ('pending', 'confirmed', 'waitlisted')
       and s.starts_at > now();
    get diagnostics v_n = row_count;
    if v_n = 0 then
      raise exception 'There are no sessions left that can still be cancelled.';
    end if;
    foreach v_slot in array v_slots loop
      perform public.offer_term_place(v_slot);
    end loop;
    return v_n;
  end if;

  -- ---- No policy set: the activity's rules, exactly as 00264.
  select a.allow_cancellation, a.cancellation_cutoff_hours, a.cancellation_refund_mode
    into v_allow, v_cut, v_mode
  from public.terms t join public.activities a on a.id = t.activity_id
  where t.id = v_e.term_id;
  if not coalesce(v_allow, true) then
    raise exception 'The provider does not allow cancellations for this class. Contact them to withdraw.';
  end if;

  update public.bookings b
     set status = 'cancelled',
         cancel_refund_mode = case when v_started then 'none' else coalesce(v_mode, 'refund') end,
         cancel_reason = case when v_started then 'Withdrew after the term started' else b.cancel_reason end
    from public.activity_sessions s
   where s.id = b.session_id
     and b.term_enrolment_id = any (v_ids)
     and b.user_id = v_user
     and b.status in ('pending', 'confirmed', 'waitlisted')
     and s.starts_at - make_interval(hours => coalesce(s.cancellation_cutoff_hours, v_cut, 0)) > now();
  get diagnostics v_n = row_count;
  if v_n = 0 then
    raise exception 'There are no sessions left that can still be cancelled.';
  end if;
  foreach v_slot in array v_slots loop
    perform public.offer_term_place(v_slot);
  end loop;
  return v_n;
end;
$$;

-- ---------------------------------------------------------------------------
-- term_session_gate (from 00275)
-- ---------------------------------------------------------------------------
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
  -- 00275: what THIS group offers (its own setting, else the term's).
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

revoke all on function public.withdraw_from_term(uuid) from public, anon;
grant execute on function public.withdraw_from_term(uuid) to authenticated;
revoke all on function public.term_session_gate() from public, anon, authenticated;

commit;
