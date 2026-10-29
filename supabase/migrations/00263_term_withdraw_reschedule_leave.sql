-- 00263_term_withdraw_reschedule_leave.sql
--
-- Three open decisions, answered by Aman on 29 Oct 2026:
--
--   2. Withdrawing from a term: the vendor's cancellation switch decides
--      whether a parent may withdraw online at all (as before). When they
--      may, there is no refund once the term has started, i.e. once the first
--      session's booking window has closed. Before that, the activity's own
--      cancellation rule applies, as before.
--   6. A term booking (enrolment, trial, single, pack or make-up seat on a
--      term session) can't be moved to another session online. Parents ask
--      the vendor; the vendor (and trusted server paths) can still move it.
--   7. A parent can always leave a waitlist place that nothing was paid for,
--      on any class, even when the vendor has switched cancellations off.
--      leave_waitlist() does that; cancel_booking() is unchanged.
--
-- For ordinary classes only leave_waitlist() is new (opt-in: an older parent
-- app never calls it), and the reschedule guard only runs for term bookings.
--
-- Idempotent.

begin;

-- =============================================================
-- 1. Withdraw: no refund once the term has started (decision 2)
-- =============================================================
-- 00260's function with the refund rule changed.
create or replace function public.withdraw_from_term(p_enrolment_id uuid)
returns int
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_user    uuid := auth.uid();
  v_e       public.term_enrolments;
  v_allow   boolean;
  v_cut     int;
  v_mode    text;
  v_started boolean;
  v_n       int;
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

  -- Started = a session of the group has passed its booking window (the
  -- moment term_quote counts it as run).
  select coalesce((select q.sessions_passed > 0 from public.term_quote(v_e.slot_id) q), false) into v_started;

  update public.bookings b
     set status = 'cancelled',
         cancel_refund_mode = case when v_started then 'none' else coalesce(v_mode, 'refund') end,
         cancel_reason = case when v_started then 'Withdrew after the term started' else b.cancel_reason end
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
  -- 00260: a whole place may now be free.
  perform public.offer_term_place(v_e.slot_id);
  return v_n;
end;
$$;

-- =============================================================
-- 2. Term bookings aren't moved online (decision 6)
-- =============================================================
create or replace function public.term_booking_move_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;
  -- The vendor running the class (from the session, not a column the row carries).
  if exists (select 1 from public.activity_sessions s
             join public.activities a on a.id = s.activity_id
             where s.id = old.session_id
               and a.provider_id in (select public.user_manage_provider_ids())) then
    return new;
  end if;
  raise exception 'Term sessions can''t be moved online. Ask the provider if you need a different date.';
end;
$$;

drop trigger if exists term_booking_move_guard on public.bookings;
create trigger term_booking_move_guard before update of session_id on public.bookings
  for each row
  when (old.term_booking_kind is not null and new.session_id is distinct from old.session_id)
  execute function public.term_booking_move_guard();

-- =============================================================
-- 3. Leave any unpaid waitlist place (decision 7)
-- =============================================================
-- One place (p_booking_id) or a whole booking (p_group_id): only its
-- waitlisted places that nothing paid for are left. Wix events and courses
-- have no BabyBrain waitlist, so they never match.
create or replace function public.leave_waitlist(p_booking_id uuid default null, p_group_id uuid default null)
returns int
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_user uuid := auth.uid();
  v_n    int;
begin
  if v_user is null then raise exception 'Not authenticated'; end if;
  if p_booking_id is null and p_group_id is null then raise exception 'Booking not found'; end if;

  update public.bookings b
     set status = 'cancelled',
         cancel_refund_mode = 'refund'
   where b.user_id = v_user
     and b.status = 'waitlisted'
     and b.payment_status <> 'paid'
     and b.package_purchase_id is null
     and not exists (select 1 from public.make_up_tokens t
                      where t.redeemed_booking_id = b.id and t.status = 'redeemed')
     and (b.id = p_booking_id or (p_group_id is not null and b.booking_group_id = p_group_id));
  get diagnostics v_n = row_count;
  if v_n = 0 then
    raise exception 'This waitlist place can''t be left online. Contact the provider if you need help.';
  end if;
  return v_n;
end;
$$;

revoke all on function public.withdraw_from_term(uuid) from public, anon;
grant execute on function public.withdraw_from_term(uuid) to authenticated;
revoke all on function public.term_booking_move_guard() from public, anon, authenticated;
revoke all on function public.leave_waitlist(uuid, uuid) from public, anon;
grant execute on function public.leave_waitlist(uuid, uuid) to authenticated;

notify pgrst, 'reload schema';

commit;
