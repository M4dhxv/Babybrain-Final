-- 00260_term_place_waitlist.sql
--
-- Waiting for a place in a term: Phase 2 of the term waitlist design agreed
-- with Aman on 29 Oct 2026. A term place is a seat on every session still to
-- come in one slot, so it can't be an ordinary waitlisted booking: it gets its
-- own list, one entry per child per slot. The rules carry over from the class
-- waitlist (00197): joining is free, everyone waiting is told when a place
-- opens, the first to enrol gets it, and their seats are held for 45 minutes
-- while they pay.
--
--   * term_waitlist: the entries. Written only through the functions below.
--   * term_slot_free_places(): free seats on the slot's fullest session still
--     to come. That is how many term places there are.
--   * join_term_waitlist() / leave_term_waitlist_entry() for the parent;
--     my_term_waitlist() for their Bookings tab.
--   * offer_term_place(): tells everyone waiting on a slot that a place is
--     free. Agreed rule (decision 2): only when a WHOLE place frees, i.e. a
--     family withdraws (withdraw_from_term, vendor_withdraw_from_term), an
--     unpaid enrolment or hold lapses (the 5-minute clean-up, an expired
--     checkout), or the vendor raises the slot's capacity. A seat freeing on
--     one session is offered to that session's single and trial waiters only.
--   * enrol_in_term(): a waiting family enrols the ordinary way and pays the
--     ordinary mid-term price (decision 1: the vendor's own rule); their entry
--     moves to 'holding', and to 'enrolled' once the seats are paid. A
--     "slot is full" for them reads "you're still on the waitlist". It also
--     no longer double-books a session the child already holds as a single,
--     trial or pack booking: that session is left out and not charged for.
--
-- Not here: the vendor's view, offers and nudges (Phase 3); closing entries
-- when a term closes to new families, and "next term is open" (Phase 4).
--
-- Every function that ordinary classes use is untouched. The one new trigger
-- on bookings only runs for a term enrolment's seats.
--
-- Idempotent.

begin;

-- =============================================================
-- 1. The list
-- =============================================================
create table if not exists public.term_waitlist (
  id                 uuid primary key default gen_random_uuid(),
  term_id            uuid not null references public.terms (id) on delete cascade,
  slot_id            uuid not null references public.term_slots (id) on delete cascade,
  provider_id        uuid not null references public.providers (id) on delete cascade,
  user_id            uuid not null references public.parent_profiles (id) on delete cascade,
  child_id           uuid references public.children (id) on delete set null,
  -- What the parent agreed to and told the provider when joining, so taking
  -- a place later doesn't ask again.
  policies_accepted  uuid[] not null default '{}',
  medical_disclosure text,
  info_response      text,
  -- waiting: on the list. holding: enrolled and paying (45 minutes).
  -- enrolled / left / closed / removed: finished with.
  status             text not null default 'waiting'
                       check (status in ('waiting', 'holding', 'enrolled', 'left', 'closed', 'removed')),
  -- Order of joining, for the vendor's list. Parents are never served in order.
  position           int  not null,
  vendor_offered     boolean not null default false,
  hold_enrolment_id  uuid references public.term_enrolments (id) on delete set null,
  last_told_at       timestamptz,
  created_at         timestamptz not null default now(),
  ended_at           timestamptz,
  end_reason         text
);
create unique index if not exists term_waitlist_one_live_per_child
  on public.term_waitlist (slot_id, user_id, coalesce(child_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where status in ('waiting', 'holding');
create index if not exists term_waitlist_slot_idx on public.term_waitlist (slot_id, status);
create index if not exists term_waitlist_user_idx on public.term_waitlist (user_id, created_at desc);
create index if not exists term_waitlist_hold_idx on public.term_waitlist (hold_enrolment_id) where hold_enrolment_id is not null;

alter table public.term_waitlist enable row level security;
drop policy if exists "read own term waitlist" on public.term_waitlist;
create policy "read own term waitlist" on public.term_waitlist
  for select using (user_id = auth.uid());
drop policy if exists "members read provider term waitlist" on public.term_waitlist;
create policy "members read provider term waitlist" on public.term_waitlist
  for select using (provider_id in (select public.user_provider_ids()));

-- =============================================================
-- 2. How many term places a slot has free
-- =============================================================
-- The fullest session still open for booking decides. 0 when none are left.
create or replace function public.term_slot_free_places(p_slot_id uuid)
returns int
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce(min(
           case when s.capacity is null then 2147483647
                else greatest(0, s.capacity - (select count(*) from public.bookings b
                                                where b.session_id = s.id
                                                  and b.status in ('pending', 'confirmed')))::int
           end), 0)
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  where s.term_slot_id = p_slot_id
    and s.status is distinct from 'cancelled'
    and s.starts_at - make_interval(mins => coalesce(s.booking_cutoff_minutes, a.booking_cutoff_minutes, 15)) > now();
$$;

-- =============================================================
-- 3. Tell everyone waiting that a place is free
-- =============================================================
create or replace function public.offer_term_place(p_slot_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_slot   public.term_slots;
  v_term   public.terms;
  v_act    record;
  v_quote  record;
  v_first  timestamptz;
  v_price  text;
  r        record;
begin
  -- Most slots have nobody waiting: nothing else to work out.
  if not exists (select 1 from public.term_waitlist w where w.slot_id = p_slot_id and w.status = 'waiting') then
    return;
  end if;
  -- One event can call this once per seat it frees; tell people once.
  if exists (select 1 from public.term_waitlist w where w.slot_id = p_slot_id and w.last_told_at = now()) then
    return;
  end if;

  select ts.* into v_slot from public.term_slots ts where ts.id = p_slot_id;
  select t.* into v_term from public.terms t where t.id = v_slot.term_id;
  if v_term.status is distinct from 'published' then return; end if;
  select a.title, a.slug, coalesce(a.bookings_paused, false) as paused,
         coalesce(a.booking_cutoff_minutes, 15) as cutoff
    into v_act
  from public.activities a where a.id = v_term.activity_id;
  if v_act.paused then return; end if;

  select * into v_quote from public.term_quote(p_slot_id);
  if not v_quote.joinable then return; end if;
  if public.term_slot_free_places(p_slot_id) <= 0 then return; end if;

  select min(s.starts_at) into v_first
  from public.activity_sessions s
  where s.term_slot_id = p_slot_id
    and s.status is distinct from 'cancelled'
    and s.starts_at - make_interval(mins => coalesce(s.booking_cutoff_minutes, v_act.cutoff)) > now();
  v_price := '$' || case when v_quote.price_cents % 100 = 0 then (v_quote.price_cents / 100)::text
                         else to_char(v_quote.price_cents / 100.0, 'FM999990.00') end;

  -- One message per family, even with two children waiting.
  for r in
    select distinct on (w.user_id) w.id, w.user_id, w.child_id
    from public.term_waitlist w
    where w.slot_id = p_slot_id and w.status = 'waiting'
    order by w.user_id, w.position
  loop
    insert into public.notifications (user_id, type, title, body, data)
    values (
      r.user_id,
      'term_waitlist_place_open',
      'A place is free in ' || v_term.name,
      'A place has opened in ' || v_term.name || ' (' || coalesce(v_act.title, 'your class') || '): '
        || v_quote.sessions_left || ' sessions from '
        || to_char(v_first at time zone 'Asia/Singapore', 'Dy FMDD Mon') || ', ' || v_price
        || '. The first family to enrol gets it. You haven''t been charged anything.',
      jsonb_build_object(
        'url', '/book?slug=' || coalesce(v_act.slug, '') || '&term_slot=' || p_slot_id || '&mode=term'
               || coalesce('&child=' || r.child_id, ''),
        'term_name', v_term.name,
        'activity_name', v_act.title,
        'slot_id', p_slot_id,
        'entry_id', r.id,
        'sessions_left', v_quote.sessions_left,
        'price_cents', v_quote.price_cents,
        'first_session', to_char(v_first at time zone 'Asia/Singapore', 'Dy FMDD Mon, FMHH12:MI am')
      )
    );
  end loop;

  update public.term_waitlist set last_told_at = now()
  where slot_id = p_slot_id and status = 'waiting';
end;
$$;

-- =============================================================
-- 4. Parent: join and leave
-- =============================================================
create or replace function public.join_term_waitlist(
  p_slot_id  uuid,
  p_child_id uuid default null,
  p_policies uuid[] default '{}',
  p_medical  text default null,
  p_info     text default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_user  uuid := auth.uid();
  v_slot  public.term_slots;
  v_term  public.terms;
  v_act   record;
  v_child uuid;
  v_quote record;
  v_id    uuid;
  v_first timestamptz;
begin
  if v_user is null then
    raise exception 'Please log in again to join the waitlist';
  end if;
  select ts.* into v_slot from public.term_slots ts where ts.id = p_slot_id for update;
  if not found then
    raise exception 'That slot is no longer available';
  end if;
  select t.* into v_term from public.terms t where t.id = v_slot.term_id and t.status = 'published';
  if not found then
    raise exception 'This term is not open for enrolment';
  end if;
  select a.title, coalesce(a.bookings_paused, false) as paused into v_act
  from public.activities a where a.id = v_term.activity_id;
  if v_act.paused then
    raise exception 'Bookings for this session are currently paused.';
  end if;
  if p_child_id is not null then
    select c.id into v_child from public.children c where c.id = p_child_id and c.parent_id = v_user;
    if v_child is null then
      raise exception 'That child is no longer on your profile — pick another';
    end if;
  end if;

  -- Mid-term waiting follows the term's own joining rules.
  select * into v_quote from public.term_quote(p_slot_id);
  if not v_quote.joinable then
    raise exception '%', coalesce(v_quote.reason, 'This term is not open for enrolment');
  end if;

  if exists (
    select 1 from public.term_enrolments e
    join public.bookings b on b.term_enrolment_id = e.id
    where e.user_id = v_user and e.slot_id = p_slot_id
      and e.child_id is not distinct from v_child
      and b.status in ('confirmed', 'pending')
  ) then
    raise exception 'This child is already enrolled in this slot.';
  end if;

  -- Already waiting: the same entry, not a second one.
  select w.id into v_id from public.term_waitlist w
  where w.slot_id = p_slot_id and w.user_id = v_user
    and w.child_id is not distinct from v_child
    and w.status in ('waiting', 'holding');
  if v_id is not null then
    return v_id;
  end if;

  if public.term_slot_free_places(p_slot_id) > 0 then
    raise exception 'A place is free in this group. Enrol now instead.';
  end if;

  insert into public.term_waitlist
    (term_id, slot_id, provider_id, user_id, child_id, policies_accepted, medical_disclosure, info_response, position)
  values (
    v_term.id, p_slot_id, v_term.provider_id, v_user, v_child, coalesce(p_policies, '{}'::uuid[]),
    nullif(btrim(p_medical), ''), nullif(btrim(p_info), ''),
    (select coalesce(max(w.position), 0) + 1 from public.term_waitlist w where w.slot_id = p_slot_id)
  )
  returning id into v_id;

  select min(s.starts_at) into v_first
  from public.activity_sessions s
  where s.term_slot_id = p_slot_id and s.status is distinct from 'cancelled' and s.starts_at > now();

  insert into public.notifications (user_id, type, title, body, data)
  values (
    v_user,
    'term_waitlist_joined',
    'You''re on the waitlist for ' || v_term.name,
    'We''ll email you when a place comes free. Joining is free.',
    jsonb_build_object(
      'url', '/profile?tab=bookings',
      'term_name', v_term.name,
      'activity_name', v_act.title,
      'child_name', (select c.name from public.children c where c.id = v_child),
      'slot_id', p_slot_id,
      'entry_id', v_id,
      'first_session', to_char(v_first at time zone 'Asia/Singapore', 'Dy FMDD Mon, FMHH12:MI am'),
      'reduce_by_cents', case when v_term.reduce_enabled then v_term.reduce_by_cents else 0 end
    )
  );
  return v_id;
end;
$$;

-- A waiting family leaves. One holding a place (paying) gives the place back.
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
     set status = 'left', ended_at = now(), end_reason = 'Left by the parent', hold_enrolment_id = null
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

-- The parent's Bookings tab: their live entries, whether a place is free now,
-- and whether the child has since got into another group of the same term
-- (the card then asks "stay on this waitlist?", decision 3).
create or replace function public.my_term_waitlist()
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
         l.created_at
  from live l
  left join public.children c on c.id = l.child_id
  cross join lateral public.term_quote(l.slot_id) q
  order by l.created_at desc;
end;
$$;

-- =============================================================
-- 5. Enrol: a waiting family takes the place; no double booking
-- =============================================================
-- 00257's function with three changes, marked 00260.
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
  select w.id into v_wait from public.term_waitlist w
  where w.slot_id = p_slot_id and w.user_id = v_user
    and w.child_id is not distinct from v_child
    and w.status = 'waiting'
  for update;

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
        if v_wait is not null then
          raise exception 'That place has just been taken — you''re still on the waitlist.';
        end if;
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
-- 6. Follow the held seats: paid -> enrolled; lapsed -> waiting again
-- =============================================================
-- Only a term enrolment's seats reach this (the WHEN clause), so ordinary
-- bookings never call it. An unpaid enrolment's seats going pending ->
-- cancelled is a whole place lapsing (the 5-minute clean-up, an expired
-- checkout, a parent starting again): the place is offered to the waitlist.
create or replace function public.term_waitlist_follow_booking()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_slot uuid;
begin
  if new.status = 'confirmed' then
    update public.term_waitlist
       set status = 'enrolled', ended_at = now()
     where hold_enrolment_id = new.term_enrolment_id and status = 'holding';
  elsif new.status = 'cancelled' and old.status = 'pending' and new.payment_status = 'none' then
    update public.term_waitlist
       set status = 'waiting', hold_enrolment_id = null
     where hold_enrolment_id = new.term_enrolment_id and status = 'holding';
    select s.term_slot_id into v_slot from public.activity_sessions s where s.id = new.session_id;
    if v_slot is not null then
      perform public.offer_term_place(v_slot);
    end if;
  end if;
  return null;
end;
$$;

drop trigger if exists term_waitlist_follow_booking on public.bookings;
create trigger term_waitlist_follow_booking after update of status on public.bookings
  for each row
  when (new.term_booking_kind = 'term' and new.term_enrolment_id is not null and old.status is distinct from new.status)
  execute function public.term_waitlist_follow_booking();

-- =============================================================
-- 7. Whole places freed: withdrawals and a bigger slot
-- =============================================================
-- 00257's withdraw functions, each now offering the freed place.
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
  -- 00260: a whole place may now be free.
  perform public.offer_term_place(v_e.slot_id);
  return v_n;
end;
$$;

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
  -- 00260: a whole place may now be free.
  perform public.offer_term_place(v_e.slot_id);
  return v_n;
end;
$$;

-- 00256's capacity follower: also offers the new places to the term waitlist.
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
    if new.capacity > old.capacity then
      perform public.offer_term_place(new.id);
    end if;
  end if;
  return new;
end;
$$;

-- =============================================================
-- 8. Who may call what
-- =============================================================
revoke all on table public.term_waitlist from anon;
grant select on table public.term_waitlist to authenticated;
revoke all on function public.term_slot_free_places(uuid) from public, anon, authenticated;
revoke all on function public.offer_term_place(uuid) from public, anon, authenticated;
revoke all on function public.term_waitlist_follow_booking() from public, anon, authenticated;
revoke all on function public.join_term_waitlist(uuid, uuid, uuid[], text, text) from public, anon;
grant execute on function public.join_term_waitlist(uuid, uuid, uuid[], text, text) to authenticated;
revoke all on function public.leave_term_waitlist_entry(uuid) from public, anon;
grant execute on function public.leave_term_waitlist_entry(uuid) to authenticated;
revoke all on function public.my_term_waitlist() from public, anon;
grant execute on function public.my_term_waitlist() to authenticated;
revoke all on function public.enrol_in_term(uuid, uuid, uuid[], text, text, uuid) from public, anon;
grant execute on function public.enrol_in_term(uuid, uuid, uuid[], text, text, uuid) to authenticated;
revoke all on function public.withdraw_from_term(uuid) from public, anon;
grant execute on function public.withdraw_from_term(uuid) to authenticated;
revoke all on function public.vendor_withdraw_from_term(uuid, text, text) from public, anon;
grant execute on function public.vendor_withdraw_from_term(uuid, text, text) to authenticated;
revoke all on function public.term_slot_capacity_follow() from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;
