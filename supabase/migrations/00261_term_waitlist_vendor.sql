-- 00261_term_waitlist_vendor.sql
--
-- The vendor's side of the term waitlist: Phase 3 of the design agreed with
-- Aman on 29 Oct 2026 (builds on 00259 and 00260).
--
--   * term_waitlist_roster(): everyone waiting on a term, per group: families
--     waiting for a term place, and those waiting for a trial or single
--     session of it. term_waitlist_counts(): how many, and how many term
--     places each group has free.
--   * vendor_offer_term_place(): a personal offer to one waiting family, like
--     "Promote" on a class. It may go over capacity: when that family enrols,
--     each full session grows by one seat (enrol_in_term), and gives it back
--     if they don't pay (term_waitlist_follow_booking).
--   * vendor_tell_term_waitlist(): tell everyone waiting about a place that
--     opened without a family leaving, which is not announced on its own
--     (decision 2).
--   * vendor_remove_from_term_waitlist(): take a family off, with an optional
--     reason; they are told.
--   * "Someone joined your term waitlist" to the vendor's team, one per family
--     per group (provider_term_waitlist_joined).
--   * The parent's offers: my_term_waitlist() gains vendor_offered, and they
--     get a 'term_waitlist_offer' or 'term_waitlist_removed' message.
--
-- Term-only throughout; nothing an ordinary class uses changes.
--
-- Idempotent.

begin;

-- =============================================================
-- 1. Vendor: who is waiting, and how full each group is
-- =============================================================
create or replace function public.term_waitlist_roster(p_term_id uuid)
returns table (
  kind              text,
  id                uuid,
  slot_id           uuid,
  session_id        uuid,
  session_starts_at timestamptz,
  child_name        text,
  child_dob         date,
  parent_name       text,
  parent_email      text,
  status            text,
  queue_position    int,
  joined_at         timestamptz
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
  -- Waiting for a term place.
  select 'term'::text, w.id, w.slot_id, null::uuid, null::timestamptz,
         coalesce(c.name, 'Child'), c.date_of_birth, nullif(btrim(pp.full_name), ''), pp.email,
         case when w.status = 'holding' then 'holding' when w.vendor_offered then 'offered' else 'waiting' end,
         w.position, w.created_at
  from public.term_waitlist w
  left join public.children c on c.id = w.child_id
  left join public.parent_profiles pp on pp.id = w.user_id
  where w.term_id = p_term_id and w.status in ('waiting', 'holding')
  union all
  -- Waiting for a trial, single or pack session of the term (00259).
  select coalesce(b.term_booking_kind, 'single'), b.id, s.term_slot_id, s.id, s.starts_at,
         coalesce(c.name, b.guest_name, 'Guest'), c.date_of_birth, nullif(btrim(pp.full_name), ''), pp.email,
         case when b.waitlist_pay_invited then 'offered' else 'waiting' end,
         b.waitlist_position, b.created_at
  from public.bookings b
  join public.activity_sessions s on s.id = b.session_id
  join public.term_slots ts on ts.id = s.term_slot_id
  left join public.children c on c.id = b.child_id
  left join public.parent_profiles pp on pp.id = b.user_id
  where ts.term_id = p_term_id and b.status = 'waitlisted' and s.starts_at > now()
  order by 3, 5 nulls first, 11, 12;
end;
$$;

create or replace function public.term_waitlist_counts(p_term_id uuid)
returns table (slot_id uuid, waiting int, session_waiting int, free_places int)
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
         (select count(*)::int from public.term_waitlist w where w.slot_id = ts.id and w.status = 'waiting'),
         (select count(*)::int from public.bookings b
            join public.activity_sessions s on s.id = b.session_id
           where s.term_slot_id = ts.id and b.status = 'waitlisted' and s.starts_at > now()),
         public.term_slot_free_places(ts.id)
  from public.term_slots ts
  where ts.term_id = p_term_id
  order by ts.position;
end;
$$;

-- =============================================================
-- 2. Vendor: offer one family a place, tell everyone, remove
-- =============================================================
create or replace function public.vendor_offer_term_place(p_entry_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_w     public.term_waitlist;
  v_term  public.terms;
  v_act   record;
  v_quote record;
  v_first timestamptz;
  v_price text;
  v_child text;
  v_who   text;
begin
  select * into v_w from public.term_waitlist where id = p_entry_id for update;
  if not found or v_w.provider_id not in (select public.user_manage_provider_ids()) then
    raise exception 'not authorized';
  end if;
  if v_w.status <> 'waiting' then
    raise exception 'This family is no longer waiting.';
  end if;
  select t.* into v_term from public.terms t where t.id = v_w.term_id;
  select * into v_quote from public.term_quote(v_w.slot_id);
  if not v_quote.joinable then
    raise exception '%', coalesce(v_quote.reason, 'This term is not open for enrolment');
  end if;
  select a.title, a.slug, coalesce(a.booking_cutoff_minutes, 15) as cutoff into v_act
  from public.activities a where a.id = v_term.activity_id;
  select min(s.starts_at) into v_first
  from public.activity_sessions s
  where s.term_slot_id = v_w.slot_id and s.status is distinct from 'cancelled'
    and s.starts_at - make_interval(mins => coalesce(s.booking_cutoff_minutes, v_act.cutoff)) > now();
  v_price := '$' || case when v_quote.price_cents % 100 = 0 then (v_quote.price_cents / 100)::text
                         else to_char(v_quote.price_cents / 100.0, 'FM999990.00') end;
  select c.name into v_child from public.children c where c.id = v_w.child_id;
  select coalesce(nullif(btrim(p.business_name), ''), 'The provider') into v_who
  from public.providers p where p.id = v_w.provider_id;

  update public.term_waitlist set vendor_offered = true where id = p_entry_id;

  insert into public.notifications (user_id, type, title, body, data)
  values (
    v_w.user_id,
    'term_waitlist_offer',
    v_who || ' has offered ' || coalesce(v_child, 'you') || ' a place',
    'A place in ' || v_term.name || ' (' || coalesce(v_act.title, 'your class') || ') is offered to you: '
      || v_quote.sessions_left || ' sessions from '
      || to_char(v_first at time zone 'Asia/Singapore', 'Dy FMDD Mon') || ', ' || v_price
      || '. Enrol and pay to confirm it.',
    jsonb_build_object(
      'url', '/book?slug=' || coalesce(v_act.slug, '') || '&term_slot=' || v_w.slot_id || '&mode=term&offered=1'
             || coalesce('&child=' || v_w.child_id, ''),
      'provider_name', v_who,
      'term_name', v_term.name,
      'activity_name', v_act.title,
      'child_name', v_child,
      'slot_id', v_w.slot_id,
      'entry_id', v_w.id,
      'sessions_left', v_quote.sessions_left,
      'price_cents', v_quote.price_cents,
      'first_session', to_char(v_first at time zone 'Asia/Singapore', 'Dy FMDD Mon, FMHH12:MI am')
    )
  );
end;
$$;

-- A place opened without a family leaving isn't announced (decision 2); the
-- vendor can announce it. Returns how many families were told.
create or replace function public.vendor_tell_term_waitlist(p_slot_id uuid)
returns int
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_provider uuid;
  v_n        int;
begin
  select t.provider_id into v_provider
  from public.term_slots ts join public.terms t on t.id = ts.term_id
  where ts.id = p_slot_id;
  if v_provider is null or v_provider not in (select public.user_manage_provider_ids()) then
    raise exception 'not authorized';
  end if;
  select count(distinct w.user_id)::int into v_n
  from public.term_waitlist w where w.slot_id = p_slot_id and w.status = 'waiting';
  if v_n = 0 then
    raise exception 'Nobody is waiting for this group.';
  end if;
  if public.term_slot_free_places(p_slot_id) <= 0 then
    raise exception 'There is no free place in this group right now. Raise its places, or offer one family a place.';
  end if;
  perform public.offer_term_place(p_slot_id);
  return v_n;
end;
$$;

create or replace function public.vendor_remove_from_term_waitlist(p_entry_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_w     public.term_waitlist;
  v_term  public.terms;
  v_title text;
  v_child text;
  v_who   text;
begin
  select * into v_w from public.term_waitlist where id = p_entry_id for update;
  if not found or v_w.provider_id not in (select public.user_manage_provider_ids()) then
    raise exception 'not authorized';
  end if;
  if v_w.status not in ('waiting', 'holding') then
    raise exception 'This family is no longer waiting.';
  end if;
  update public.term_waitlist
     set status = 'removed', ended_at = now(), end_reason = coalesce(nullif(btrim(p_reason), ''), 'Removed by the provider')
   where id = p_entry_id;
  if v_w.status = 'holding' and v_w.hold_enrolment_id is not null then
    update public.bookings
       set status = 'cancelled', cancel_reason = 'Removed from the waitlist', cancelled_by = auth.uid()
     where term_enrolment_id = v_w.hold_enrolment_id
       and status = 'pending' and payment_status = 'none';
  end if;

  select t.* into v_term from public.terms t where t.id = v_w.term_id;
  select a.title into v_title from public.activities a where a.id = v_term.activity_id;
  select c.name into v_child from public.children c where c.id = v_w.child_id;
  select coalesce(nullif(btrim(p.business_name), ''), 'The provider') into v_who
  from public.providers p where p.id = v_w.provider_id;
  insert into public.notifications (user_id, type, title, body, data)
  values (
    v_w.user_id,
    'term_waitlist_removed',
    'You''re no longer on the waitlist for ' || v_term.name,
    v_who || ' has taken ' || coalesce(v_child, 'your child') || ' off the waitlist for ' || v_term.name
      || ' (' || coalesce(v_title, 'the class') || ').'
      || coalesce(' ' || nullif(btrim(p_reason), ''), '') || ' You haven''t been charged anything.',
    jsonb_build_object(
      'url', '/profile?tab=bookings',
      'provider_name', v_who,
      'term_name', v_term.name,
      'activity_name', v_title,
      'child_name', v_child,
      'reason', nullif(btrim(p_reason), '')
    )
  );
end;
$$;

-- =============================================================
-- 3. "Someone joined your term waitlist", to the vendor's team
-- =============================================================
create or replace function public.notify_provider_term_waitlist_joined()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_waiting int;
  v_child   text;
begin
  -- A brother or sister joining with them: one message per family per group.
  if exists (select 1 from public.term_waitlist w
             where w.slot_id = new.slot_id and w.user_id = new.user_id and w.id <> new.id
               and w.status in ('waiting', 'holding')) then
    return new;
  end if;
  select count(*)::int into v_waiting from public.term_waitlist w where w.slot_id = new.slot_id and w.status = 'waiting';
  select coalesce((select c.name from public.children c where c.id = new.child_id), 'A family') into v_child;

  insert into public.notifications (user_id, type, title, body, data)
  select m.user_id, 'provider_term_waitlist_joined', 'Someone joined your term waitlist ' || E'⏳',
         v_child || ' is waiting for a place in ' || t.name || ' (' || a.title || '). '
           || v_waiting || case when v_waiting = 1 then ' child is' else ' children are' end
           || ' waiting for this group. If you can take more, raise its places.',
         jsonb_build_object(
           -- Hash routes (/vendor/#/…): the Activities page holds each activity's terms.
           'url', '/vendor/#/activities',
           'term_id', new.term_id,
           'slot_id', new.slot_id,
           'term_name', t.name,
           'activity_name', a.title,
           'child_name', v_child,
           'waiting_count', v_waiting)
  from public.provider_members m
  join public.terms t on t.id = new.term_id
  join public.activities a on a.id = t.activity_id
  where m.provider_id = new.provider_id and m.status = 'active';
  return new;
end;
$$;

drop trigger if exists on_provider_term_waitlist_joined on public.term_waitlist;
create trigger on_provider_term_waitlist_joined
  after insert on public.term_waitlist
  for each row execute function public.notify_provider_term_waitlist_joined();

-- =============================================================
-- 4. Parent: offers show on their card
-- =============================================================
drop function if exists public.my_term_waitlist();
create function public.my_term_waitlist()
returns table (
  id                 uuid,
  status             text,
  slot_id            uuid,
  term_name          text,
  activity_title     text,
  slug               text,
  child_id           uuid,
  child_name         text,
  next_session       timestamptz,
  sessions_left      int,
  price_cents        int,
  joinable           boolean,
  free_places        int,
  enrolled_elsewhere boolean,
  vendor_offered     boolean,
  created_at         timestamptz
)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  return query
  -- Published terms only, before term_quote() runs (it refuses any other).
  with live as materialized (
    select w.*, t.name as term_name, a.title as activity_title, a.slug
    from public.term_waitlist w
    join public.terms t on t.id = w.term_id
    join public.activities a on a.id = t.activity_id
    where w.user_id = auth.uid()
      and w.status in ('waiting', 'holding')
      and t.status = 'published'
  )
  select l.id, l.status, l.slot_id, l.term_name, l.activity_title, l.slug, l.child_id, c.name,
         (select min(s.starts_at) from public.activity_sessions s
           where s.term_slot_id = l.slot_id and s.status is distinct from 'cancelled' and s.starts_at > now()),
         q.sessions_left, q.price_cents, q.joinable,
         public.term_slot_free_places(l.slot_id),
         exists (select 1 from public.term_enrolments e
                 join public.bookings b on b.term_enrolment_id = e.id
                 where e.term_id = l.term_id and e.slot_id <> l.slot_id
                   and e.user_id = l.user_id and e.child_id is not distinct from l.child_id
                   and b.status in ('pending', 'confirmed')),
         l.vendor_offered,
         l.created_at
  from live l
  left join public.children c on c.id = l.child_id
  cross join lateral public.term_quote(l.slot_id) q
  order by l.created_at desc;
end;
$$;

-- Leaving keeps the last hold on the entry, so the seat a vendor's offer
-- added can be given back when its unpaid seats are cancelled (section 6).
create or replace function public.leave_term_waitlist_entry(p_entry_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_user uuid := auth.uid();
  v_w    public.term_waitlist;
begin
  if v_user is null then raise exception 'Not authenticated'; end if;
  select * into v_w from public.term_waitlist where id = p_entry_id and user_id = v_user for update;
  if not found or v_w.status not in ('waiting', 'holding') then
    raise exception 'You''re no longer on this waitlist.';
  end if;
  update public.term_waitlist
     set status = 'left', ended_at = now(), end_reason = 'Left by the parent'
   where id = p_entry_id;
  if v_w.status = 'holding' and v_w.hold_enrolment_id is not null then
    -- Unpaid seats only. Their trigger offers the place to everyone else.
    update public.bookings
       set status = 'cancelled'
     where term_enrolment_id = v_w.hold_enrolment_id
       and status = 'pending' and payment_status = 'none';
  end if;
end;
$$;

-- =============================================================
-- 5. Enrol: an offered family may go over capacity
-- =============================================================
-- 00260's function; the changes are marked 00261.
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
  v_left     int;
  v_sid      uuid;
  v_cap      int;
  v_taken    int;
  v_enrol    uuid;
  v_group    uuid;
  v_status   text;
  v_prev     record;
  v_price    int;
  v_wait     uuid;
  v_offered  boolean := false;
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

  -- 00260: this child's place on the waitlist, if they have one.
  -- 00261: and whether the vendor offered it to them.
  select w.id, w.vendor_offered into v_wait, v_offered from public.term_waitlist w
  where w.slot_id = p_slot_id and w.user_id = v_user
    and w.child_id is not distinct from v_child
    and w.status = 'waiting'
  for update;
  v_offered := coalesce(v_offered, false);

  -- Lock every session still to come, in a fixed order, and check each has a seat.
  -- 00260: count them all (v_left), but leave out any the child already holds
  -- as a single, trial or pack booking: they keep that seat, it isn't taken
  -- twice, and it isn't charged for (checkout charges price x seats / v_left).
  select array_agg(q.id order by q.starts_at, q.id) filter (where not q.held), count(*)
    into v_ids, v_left
  from (
    select s.id, s.starts_at,
           exists (select 1 from public.bookings b
                   where b.session_id = s.id
                     and b.status in ('pending', 'confirmed')
                     and ((v_child is not null and b.child_id = v_child)
                          or (v_child is null and b.child_id is null and b.user_id = v_user))) as held
    from public.activity_sessions s
    where s.term_slot_id = p_slot_id
      and s.status is distinct from 'cancelled'
      and s.starts_at - make_interval(mins => coalesce(s.booking_cutoff_minutes, v_cutoff)) > now()
    order by s.starts_at, s.id
    for update of s
  ) q;
  if coalesce(v_left, 0) = 0 then
    raise exception 'There are no sessions left to enrol in.';
  end if;
  if v_ids is null or array_length(v_ids, 1) = 0 then
    raise exception 'This child already has a place on every session left.';
  end if;

  foreach v_sid in array v_ids loop
    select s.capacity into v_cap from public.activity_sessions s where s.id = v_sid;
    if v_cap is not null then
      select count(*) into v_taken from public.bookings b
      where b.session_id = v_sid and b.status in ('pending', 'confirmed');
      if v_taken >= v_cap then
        if v_wait is not null and v_offered then
          -- 00261: the vendor offered this family the place, which may go over
          -- capacity, as "Promote" does on a class. The session grows by one;
          -- the capacity trigger doesn't offer that seat to anyone else.
          perform set_config('bb.skip_waitlist_offer', 'on', true);
          update public.activity_sessions set capacity = v_taken + 1 where id = v_sid;
          perform set_config('bb.skip_waitlist_offer', 'off', true);
        elsif v_wait is not null then
          raise exception 'That place has just been taken — you''re still on the waitlist.';
        else
          raise exception 'This slot is full: at least one session has no place left.';
        end if;
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
  values (v_term.id, p_slot_id, v_term.provider_id, v_user, v_child, v_price, v_left, v_group)
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

  -- 00260: the waiting family has the place: held while they pay, or theirs
  -- outright for a free term.
  if v_wait is not null then
    update public.term_waitlist
       set status = case when v_status = 'confirmed' then 'enrolled' else 'holding' end,
           hold_enrolment_id = v_enrol,
           ended_at = case when v_status = 'confirmed' then now() end
     where id = v_wait;
  end if;

  return query select v_enrol, v_group, v_status, v_price, v_left;
end;
$$;

-- =============================================================
-- 6. Follow the held seats (00260), giving back an offer's extra seat
-- =============================================================
create or replace function public.term_waitlist_follow_booking()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_slot    uuid;
  v_entry   uuid;
  v_offered boolean;
  v_cap     int;
begin
  if new.status = 'confirmed' then
    update public.term_waitlist
       set status = 'enrolled', ended_at = now()
     where hold_enrolment_id = new.term_enrolment_id and status = 'holding';
  elsif new.status = 'cancelled' and old.status = 'pending' and new.payment_status = 'none' then
    -- 00261: the entry keeps its last hold, so every seat of a lapsed
    -- enrolment can find it, not only the first one cancelled.
    select w.id, w.vendor_offered into v_entry, v_offered
    from public.term_waitlist w
    where w.hold_enrolment_id = new.term_enrolment_id
    order by w.created_at desc
    limit 1;
    if v_entry is not null then
      update public.term_waitlist set status = 'waiting' where id = v_entry and status = 'holding';
      if v_offered then
        -- The seat the vendor's offer added to this session goes back.
        select ts.capacity into v_cap
        from public.activity_sessions s join public.term_slots ts on ts.id = s.term_slot_id
        where s.id = new.session_id;
        update public.activity_sessions s
           set capacity = greatest(v_cap, (select count(*) from public.bookings b
                                           where b.session_id = s.id and b.status in ('pending', 'confirmed'))::int)
         where s.id = new.session_id and s.capacity > v_cap;
      end if;
    end if;
    select s.term_slot_id into v_slot from public.activity_sessions s where s.id = new.session_id;
    if v_slot is not null then
      perform public.offer_term_place(v_slot);
    end if;
  end if;
  return null;
end;
$$;

-- =============================================================
-- 7. Who may call what
-- =============================================================
revoke all on function public.term_waitlist_roster(uuid) from public, anon;
grant execute on function public.term_waitlist_roster(uuid) to authenticated;
revoke all on function public.term_waitlist_counts(uuid) from public, anon;
grant execute on function public.term_waitlist_counts(uuid) to authenticated;
revoke all on function public.vendor_offer_term_place(uuid) from public, anon;
grant execute on function public.vendor_offer_term_place(uuid) to authenticated;
revoke all on function public.vendor_tell_term_waitlist(uuid) from public, anon;
grant execute on function public.vendor_tell_term_waitlist(uuid) to authenticated;
revoke all on function public.vendor_remove_from_term_waitlist(uuid, text) from public, anon;
grant execute on function public.vendor_remove_from_term_waitlist(uuid, text) to authenticated;
revoke all on function public.notify_provider_term_waitlist_joined() from public, anon, authenticated;
revoke all on function public.my_term_waitlist() from public, anon;
grant execute on function public.my_term_waitlist() to authenticated;
revoke all on function public.leave_term_waitlist_entry(uuid) from public, anon;
grant execute on function public.leave_term_waitlist_entry(uuid) to authenticated;
revoke all on function public.enrol_in_term(uuid, uuid, uuid[], text, text, uuid) from public, anon;
grant execute on function public.enrol_in_term(uuid, uuid, uuid[], text, text, uuid) to authenticated;
revoke all on function public.term_waitlist_follow_booking() from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;
