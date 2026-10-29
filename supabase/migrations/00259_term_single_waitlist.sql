-- 00259_term_single_waitlist.sql
--
-- Waiting for one session of a term (a trial or single session): Phase 1 of the
-- term waitlist design agreed with Aman on 29 Oct 2026. A term session already
-- uses the ordinary waitlist (book_term_class -> book_party leaves a
-- 'waitlisted' row when the session is full), so this fills the gaps around it:
--
--   1. Single places used up (term_slots.single_cap) no longer refuse the
--      booking. The parent goes on that session's waitlist, as they would for
--      a full session. One waitlist place per child per session.
--   2. "A spot is available" only reaches a single or trial waiter once a
--      single place is free, not just a seat: the cap may be keeping that seat
--      for term families. Raising single_cap tells them.
--   3. claim_term_waitlist_seats(): "Pay now" on a term session's waitlist
--      place re-checks the trial limit and the single places before holding
--      the seat (claim_waitlist_seats, 00197, only knows about capacity).
--   4. The "book now" link opens the booking page in the right mode
--      (&mode=single|trial|package): term sessions are hidden from the
--      ordinary date picker, so /book?slug=…&session=… alone can't open them.
--   5. leave_term_waitlist(): a parent can always leave a term session's
--      waitlist (nothing was paid), even when the vendor doesn't allow
--      cancellations or the cancellation window has closed.
--
-- 2 and 4 change functions every class uses (notify_waitlist_all_open from
-- 00224, notify_waitlist_spot_open from 00197). For an ordinary session both
-- behave exactly as before: term_single_places_full() is false and
-- term_booking_kind is null.
--
-- Idempotent.

begin;

-- =============================================================
-- 1. Are a term session's single places used up?
-- =============================================================
-- False for an ordinary session and for a slot with no single_cap.
create or replace function public.term_single_places_full(p_session_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce((
    select ts.single_cap is not null
       and (select count(*) from public.bookings b
             where b.session_id = s.id
               and b.term_booking_kind in ('single', 'trial')
               and b.status in ('pending', 'confirmed')) >= ts.single_cap
    from public.activity_sessions s
    join public.term_slots ts on ts.id = s.term_slot_id
    where s.id = p_session_id
  ), false);
$$;

-- =============================================================
-- 2. The booking gate: wait for a single place instead of an error
-- =============================================================
-- 00257's gate, with the single_cap block changed. before_booking_insert has
-- already run (triggers fire in name order), so new.status is 'waitlisted'
-- when the session itself is full.
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
-- 3. "Pay now" on a term session's waitlist place
-- =============================================================
-- Called by /api/terms/checkout (service role) in place of
-- claim_waitlist_seats for single and trial seats. A vendor's "Promote"
-- (waitlist_pay_invited) is an explicit offer, so it skips the single-place
-- check, as it skips capacity in claim_waitlist_seats.
create or replace function public.claim_term_waitlist_seats(p_seat_ids uuid[])
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_session  uuid;
  v_slot     public.term_slots;
  v_term     public.terms;
  v_taken    int;
  v_needed   int;
  r          record;
  v_used     int;
begin
  select b.session_id into v_session from public.bookings b where b.id = p_seat_ids[1];
  if v_session is null then
    raise exception 'Booking not found';
  end if;
  -- The lock claim_waitlist_seats takes, taken first so the counts below hold.
  perform 1 from public.activity_sessions s where s.id = v_session for update;
  select ts.* into v_slot
  from public.activity_sessions s join public.term_slots ts on ts.id = s.term_slot_id
  where s.id = v_session;
  if not found then
    raise exception 'This session is not part of a term.';
  end if;
  select t.* into v_term from public.terms t where t.id = v_slot.term_id;

  if v_slot.single_cap is not null then
    select count(*) into v_taken from public.bookings b
    where b.session_id = v_session
      and b.term_booking_kind in ('single', 'trial')
      and b.status in ('pending', 'confirmed');
    select count(*) into v_needed from public.bookings b
    where b.id = any(p_seat_ids) and b.status = 'waitlisted'
      and b.term_booking_kind in ('single', 'trial')
      and not b.waitlist_pay_invited;
    if v_needed > 0 and v_taken + v_needed > v_slot.single_cap then
      raise exception 'That spot has been taken — you''re still on the waitlist.';
    end if;
  end if;

  -- A child may have used their trial elsewhere while waiting.
  for r in
    select b.id, b.user_id, b.child_id from public.bookings b
    where b.id = any(p_seat_ids) and b.status = 'waitlisted' and b.term_booking_kind = 'trial'
  loop
    select count(*) into v_used
    from public.bookings b
    join public.activity_sessions s2 on s2.id = b.session_id
    join public.term_slots ts2 on ts2.id = s2.term_slot_id
    join public.terms t2 on t2.id = ts2.term_id
    where b.term_booking_kind = 'trial'
      and t2.provider_id = v_term.provider_id
      and b.status not in ('cancelled', 'waitlisted')
      and b.id <> r.id
      and (
        (r.child_id is not null and b.child_id = r.child_id)
        or (r.child_id is null and b.child_id is null and b.user_id = r.user_id)
      );
    if v_used >= v_term.trial_limit then
      raise exception 'This child has already used their trial with this provider. Leave this waitlist place and book the session as a single instead.';
    end if;
  end loop;

  perform public.claim_waitlist_seats(p_seat_ids);
end;
$$;

-- =============================================================
-- 4. Tell waiting families: single places, and the right booking link
-- =============================================================
-- 00224's function, plus: single and trial waiters are skipped while the
-- session's single places are used up.
create or replace function public.notify_waitlist_all_open(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r             record;
  v_cap         int;
  v_taken       int;
  v_single_full boolean;
begin
  select s.capacity into v_cap from public.activity_sessions s where s.id = p_session_id;
  if not found then return; end if;

  -- No free seat (someone else already took it): nothing to offer.
  select count(*) into v_taken from public.bookings b
   where b.session_id = p_session_id and b.status in ('pending', 'confirmed');
  if v_cap is not null and v_taken >= v_cap then return; end if;

  -- 00259: a seat is free but a term's single places are not, so a single or
  -- trial waiter still can't book it. Always false for an ordinary session.
  v_single_full := public.term_single_places_full(p_session_id);

  for r in
    select distinct on (b.user_id) b.id
      from public.bookings b
     where b.session_id = p_session_id
       and b.status = 'waitlisted'
       and b.user_id is not null
       and not (b.payment_status = 'paid'
                or b.package_purchase_id is not null
                or exists (select 1 from public.make_up_tokens t
                            where t.redeemed_booking_id = b.id and t.status = 'redeemed'))
       and not (v_single_full and coalesce(b.term_booking_kind, '') in ('single', 'trial'))
       -- Collapses duplicate calls from ONE event (same transaction) only.
       and not exists (
             select 1 from public.notifications n
              where n.user_id = b.user_id
                and n.type = 'waitlist_available'
                and n.data ->> 'session_id' = p_session_id::text
                and n.created_at = now())
     order by b.user_id, b.waitlist_position nulls last, b.created_at
  loop
    perform public.notify_waitlist_spot_open(r.id);
  end loop;
end;
$function$;

-- 00197's function, plus &mode= on a term session's link.
create or replace function public.notify_waitlist_spot_open(p_booking uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_bk   public.bookings;
  v_slug text;
begin
  select * into v_bk from public.bookings where id = p_booking;
  if not found or v_bk.user_id is null then return; end if;
  select a.slug into v_slug
    from public.activity_sessions s join public.activities a on a.id = s.activity_id
   where s.id = v_bk.session_id;
  insert into public.notifications (user_id, type, title, body, data)
  values (
    v_bk.user_id,
    'waitlist_available',
    'A spot is available — book now',
    'A place has come free on a class you''re on the waitlist for. Book now to '
      || 'take it; the first to book gets the spot. You haven''t been charged anything.',
    public.session_email_details(v_bk.session_id) || jsonb_build_object(
      -- A vendor "Promote" is a personal offer that can go over capacity, so
      -- it keeps the Pay now link on the parent's bookings; everyone else
      -- books the freed seat like any other booking.
      'url', case when v_bk.waitlist_pay_invited or v_slug is null
                  then '/profile?tab=bookings'
                  else '/book?slug=' || v_slug || '&session=' || v_bk.session_id
                       -- 00259: a term session opens in the way it was booked.
                       || case when v_bk.term_booking_kind in ('single', 'trial', 'package')
                               then '&mode=' || v_bk.term_booking_kind
                               else '' end
             end,
      'booking_id', v_bk.id,
      'session_id', v_bk.session_id
    )
  );
end;
$function$;

-- Raising a slot's single places tells the single and trial waiters on its
-- sessions still to come. No cap before means nobody was waiting on one.
create or replace function public.term_slot_single_cap_follow()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  r record;
begin
  if old.single_cap is null then
    return new;
  end if;
  if new.single_cap is not null and new.single_cap <= old.single_cap then
    return new;
  end if;
  for r in
    select s.id from public.activity_sessions s
    where s.term_slot_id = new.id
      and s.status is distinct from 'cancelled'
      and s.starts_at > now()
  loop
    perform public.notify_waitlist_all_open(r.id);
  end loop;
  return new;
end;
$$;

drop trigger if exists term_slot_single_cap on public.term_slots;
create trigger term_slot_single_cap after update of single_cap on public.term_slots
  for each row execute function public.term_slot_single_cap_follow();

-- =============================================================
-- 5. Parent: leave a term session's waitlist
-- =============================================================
-- Nothing was paid for a waitlist place, so the vendor's cancellation switch
-- and window don't apply. Pass one place (p_booking_id) or a whole booking
-- (p_group_id); only its unpaid waitlist places on term sessions are left.
create or replace function public.leave_term_waitlist(p_booking_id uuid default null, p_group_id uuid default null)
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
    from public.activity_sessions s
   where s.id = b.session_id
     and s.term_slot_id is not null
     and b.user_id = v_user
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

-- =============================================================
-- 6. Who may call what
-- =============================================================
revoke all on function public.term_single_places_full(uuid) from public, anon, authenticated;
revoke all on function public.claim_term_waitlist_seats(uuid[]) from public, anon, authenticated;
grant execute on function public.claim_term_waitlist_seats(uuid[]) to service_role;
revoke all on function public.term_slot_single_cap_follow() from public, anon, authenticated;
revoke all on function public.notify_waitlist_all_open(uuid) from public, anon, authenticated;
revoke all on function public.notify_waitlist_spot_open(uuid) from public, anon, authenticated;
revoke all on function public.leave_term_waitlist(uuid, uuid) from public, anon;
grant execute on function public.leave_term_waitlist(uuid, uuid) to authenticated;

notify pgrst, 'reload schema';

commit;
