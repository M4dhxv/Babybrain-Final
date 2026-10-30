-- 00264_term_slot_groups.sql
--
-- Slot groups: a term can offer several lists of slots ("groups"), and a
-- family enrols in exactly ONE slot from EACH group, e.g. two sessions a week,
-- one from "Mon & Tue" and one from "Thu & Fri". Agreed with the client on
-- 30 Oct 2026:
--
--   * one price for the whole combination (the term's price: "2 sessions a
--     week for the term"), not a sum of per-slot prices;
--   * exactly one slot per group, every group required;
--   * a full slot makes the combination unavailable; the family can join a
--     free waitlist for that exact combination;
--   * after enrolling, only the vendor can swap a slot (within its group); a
--     parent cannot swap or part-withdraw online.
--
-- Simple and Flexible (terms.slot_mode, chosen while the term is a draft): Simple is
-- one list of slots with one pick, as terms have always worked; Flexible allows
-- several groups. A Simple term has exactly one group.
--
-- A term with a single group behaves exactly as before: existing slots are
-- put in one default group, enrol_in_term() still works for such terms, and
-- the price is still the slot's own price when it has one.
--
-- Design — a combination is NOT a new booking system. Each chosen slot still
-- gets its own term_enrolments row and its own ordinary bookings, so the
-- roster, attendance, make-up tokens, holds, the term waitlist and the Stripe
-- checkout (which already sums several enrolments sharing a booking group)
-- all keep working. The enrolments of one combination are tied together by
-- term_enrolments.combo_id and share one booking_group_id, so one checkout
-- pays for all of them. The combination price is split across the slots in
-- proportion to their remaining sessions (the odd cents go to the last slot).
--
--   term_slot_groups         the lists. Fixed once the term is published.
--   term_slots.group_id      which list a slot belongs to.
--   term_combo_quote()       what a combination costs right now.
--   enrol_in_term_combo()    enrol a child in one slot per group, all or nothing.
--   enrol_in_term()          refused for a term with more than one group.
--   join_term_combo_waitlist()   wait for a combination (see below).
--   vendor_swap_term_slot()  the vendor moves a family to another slot of the
--                            same group, moving their remaining bookings.
--
-- Waiting for a combination: one term_waitlist entry per FULL slot of the
-- combination, all sharing combo_id / combo_slot_ids. The family is told
-- (offer_term_place) only when EVERY slot of the combination has a free
-- place; then the first family to enrol the combination wins, as for a single
-- slot. Leaving, being removed or closing one entry ends the whole combination.
--
-- Withdrawing (parent or vendor) cancels the whole combination.
--
-- Idempotent.

begin;

-- =============================================================
-- 1. Groups
-- =============================================================
create table if not exists public.term_slot_groups (
  id         uuid primary key default gen_random_uuid(),
  term_id    uuid not null references public.terms (id) on delete cascade,
  name       text not null check (length(btrim(name)) > 0),
  position   int  not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists term_slot_groups_term_idx on public.term_slot_groups (term_id, position);

alter table public.term_slots
  add column if not exists group_id uuid references public.term_slot_groups (id) on delete restrict;
create index if not exists term_slots_group_idx on public.term_slots (group_id);

-- How the vendor lets parents choose. 'simple': one list of slots, the parent
-- picks one (how terms have always worked; a slot may still repeat on several
-- days). 'flexible': several groups, the parent picks one slot from each. A
-- Simple term has exactly one group, so every existing term stays Simple.
alter table public.terms
  add column if not exists slot_mode text not null default 'simple' check (slot_mode in ('simple', 'flexible'));

-- Existing terms: all their slots go in one default group.
insert into public.term_slot_groups (term_id, name, position)
select distinct ts.term_id, 'Choose your slot', 0
from public.term_slots ts
where ts.group_id is null
  and not exists (select 1 from public.term_slot_groups g where g.term_id = ts.term_id);

update public.term_slots ts
   set group_id = (select g.id from public.term_slot_groups g where g.term_id = ts.term_id order by g.position, g.created_at limit 1)
 where ts.group_id is null;

-- A slot written without a group (an older vendor portal) joins the term's
-- first group, which is created if the term has none. A slot's group must be
-- one of its own term's.
create or replace function public.term_slot_set_group()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if new.group_id is null then
    select g.id into new.group_id from public.term_slot_groups g
    where g.term_id = new.term_id order by g.position, g.created_at limit 1;
    if new.group_id is null then
      insert into public.term_slot_groups (term_id, name, position)
      values (new.term_id, 'Choose your slot', 0)
      returning id into new.group_id;
    end if;
  elsif not exists (select 1 from public.term_slot_groups g where g.id = new.group_id and g.term_id = new.term_id) then
    raise exception 'That group belongs to a different term.';
  end if;
  return new;
end;
$$;

drop trigger if exists term_slot_set_group on public.term_slots;
create trigger term_slot_set_group before insert or update of group_id, term_id on public.term_slots
  for each row execute function public.term_slot_set_group();

-- Groups are laid out while the term is a draft; once it is published a
-- family's combination depends on them, so they can be renamed but not added,
-- removed or moved to another term.
create or replace function public.term_slot_group_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_term   uuid := case when tg_op = 'DELETE' then old.term_id else new.term_id end;
  v_status text;
begin
  select t.status into v_status from public.terms t where t.id = v_term;
  if tg_op = 'UPDATE' then
    if new.term_id is distinct from old.term_id then
      raise exception 'A group can''t move to another term.';
    end if;
    return new;
  end if;
  -- A term that is being deleted takes its groups with it.
  if v_status is not null and v_status <> 'draft' then
    raise exception 'Groups can''t be added or removed once a term is published. Start a new term for a new group.';
  end if;
  if tg_op = 'INSERT' and v_status is not null
     and (select t.slot_mode from public.terms t where t.id = v_term) = 'simple'
     and exists (select 1 from public.term_slot_groups g where g.term_id = v_term) then
    raise exception 'A Simple term has one list of slots. Switch it to Flexible to add another group.';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

-- The mode is chosen while the term is a draft. Going back to Simple needs the
-- groups combined into one first.
create or replace function public.term_slot_mode_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if old.status <> 'draft' then
    raise exception 'A published term''s mode is fixed.';
  end if;
  if new.slot_mode = 'simple' and (select count(*) from public.term_slot_groups g where g.term_id = new.id) > 1 then
    raise exception 'Combine the groups into one list before switching to Simple.';
  end if;
  return new;
end;
$$;

drop trigger if exists term_slot_mode_guard on public.terms;
create trigger term_slot_mode_guard before update of slot_mode on public.terms
  for each row when (new.slot_mode is distinct from old.slot_mode)
  execute function public.term_slot_mode_guard();

drop trigger if exists term_slot_group_guard on public.term_slot_groups;
create trigger term_slot_group_guard before insert or update or delete on public.term_slot_groups
  for each row execute function public.term_slot_group_guard();

alter table public.term_slot_groups enable row level security;

drop policy if exists "read groups of readable terms" on public.term_slot_groups;
create policy "read groups of readable terms" on public.term_slot_groups
  for select using (
    exists (
      select 1 from public.terms t
      where t.id = term_slot_groups.term_id
        and (t.status = 'published' or t.provider_id in (select public.user_provider_ids()))
    )
  );

drop policy if exists "members manage groups" on public.term_slot_groups;
create policy "members manage groups" on public.term_slot_groups
  for all using (
    exists (select 1 from public.terms t
            where t.id = term_slot_groups.term_id and t.provider_id in (select public.user_provider_ids()))
  )
  with check (
    exists (select 1 from public.terms t
            where t.id = term_slot_groups.term_id and t.provider_id in (select public.user_provider_ids()))
  );

-- A published slot's group is as fixed as its days and times.
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
    if new.group_id is distinct from old.group_id then
      raise exception 'A published term''s groups are fixed.';
    end if;
  end if;
  return new;
end;
$$;

-- Publishing: every group needs a slot, and the session price (which only
-- decides free vs paid for the booking triggers; the checkout charges the
-- real price) becomes the per-session share of the whole combination.
create or replace function public.term_publish_groups_check()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_groups int;
  v_empty  text;
begin
  select count(*)::int into v_groups from public.term_slot_groups g where g.term_id = new.id;
  select string_agg(g.name, ', ' order by g.position) into v_empty
  from public.term_slot_groups g
  where g.term_id = new.id
    and not exists (select 1 from public.term_slots ts where ts.group_id = g.id);
  if v_empty is not null then
    raise exception 'Every group needs at least one slot before publishing. Empty: %.', v_empty;
  end if;
  if new.slot_mode = 'simple' and v_groups > 1 then
    raise exception 'A Simple term has one list of slots.';
  end if;
  if v_groups > 1 then
    update public.activity_sessions s
       set price = case when s.price > 0 then greatest(0.01, round(s.price / v_groups, 2)) else s.price end
     where s.term_slot_id in (select ts.id from public.term_slots ts where ts.term_id = new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists term_publish_groups_check on public.terms;
create trigger term_publish_groups_check before update of status on public.terms
  for each row when (old.status = 'draft' and new.status = 'published')
  execute function public.term_publish_groups_check();

-- =============================================================
-- 2. Columns that tie a combination together
-- =============================================================
alter table public.term_enrolments add column if not exists combo_id uuid;
create index if not exists term_enrolments_combo_idx on public.term_enrolments (combo_id) where combo_id is not null;

alter table public.term_waitlist
  add column if not exists combo_id uuid,
  add column if not exists combo_slot_ids uuid[];
create index if not exists term_waitlist_combo_idx on public.term_waitlist (combo_id) where combo_id is not null;
-- (One live combination per child per term is kept by join_term_combo_waitlist;
-- the per-slot unique index from 00260 already stops a duplicate on any one slot.)

-- A single-slot entry makes no sense in a term with several groups.
create or replace function public.term_waitlist_entry_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if new.combo_id is null and (select count(*) from public.term_slot_groups g where g.term_id = new.term_id) > 1 then
    raise exception 'This term needs one slot from each group. Join the waitlist with your full combination.';
  end if;
  return new;
end;
$$;

drop trigger if exists term_waitlist_entry_guard on public.term_waitlist;
create trigger term_waitlist_entry_guard before insert on public.term_waitlist
  for each row execute function public.term_waitlist_entry_guard();

-- Leaving, removal or closing of one entry of a combination ends the rest.
create or replace function public.term_waitlist_end_combo()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  update public.term_waitlist w
     set status = new.status, ended_at = coalesce(new.ended_at, now()), end_reason = new.end_reason
   where w.combo_id = new.combo_id and w.id <> new.id and w.status = 'waiting';
  return null;
end;
$$;

drop trigger if exists term_waitlist_end_combo on public.term_waitlist;
create trigger term_waitlist_end_combo after update of status on public.term_waitlist
  for each row
  when (new.combo_id is not null and new.status in ('left', 'closed', 'removed') and old.status is distinct from new.status)
  execute function public.term_waitlist_end_combo();

-- =============================================================
-- 3. Checking and pricing a combination
-- =============================================================
-- Do two slots ever run at the same time?
create or replace function public.term_slots_overlap(p_a uuid, p_b uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (
    select 1
    from public.activity_sessions a
    join public.activity_sessions b on b.term_slot_id = p_b
    where a.term_slot_id = p_a
      and a.status is distinct from 'cancelled' and b.status is distinct from 'cancelled'
      and tstzrange(a.starts_at, a.ends_at) && tstzrange(b.starts_at, b.ends_at)
  );
$$;

-- Is this a whole, valid combination: slots of ONE published term, exactly one
-- per group, none running at the same time as another? Returns the term id and
-- raises a plain-English reason otherwise.
create or replace function public.term_combo_check(p_slot_ids uuid[])
returns uuid
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_n       int := coalesce(array_length(p_slot_ids, 1), 0);
  v_terms   uuid[];
  v_term    public.terms;
  v_groups  int;
  v_missing text;
  v_double  text;
  v_a       uuid;
  v_b       uuid;
begin
  if v_n = 0 then
    raise exception 'Pick a slot to enrol in.';
  end if;
  if (select count(distinct x) from unnest(p_slot_ids) x) <> v_n then
    raise exception 'The same slot was picked twice.';
  end if;
  select array_agg(distinct ts.term_id) into v_terms from public.term_slots ts where ts.id = any(p_slot_ids);
  if v_terms is null or (select count(*) from public.term_slots ts where ts.id = any(p_slot_ids)) <> v_n then
    raise exception 'That slot is no longer available';
  end if;
  if array_length(v_terms, 1) <> 1 then
    raise exception 'Those slots are not part of one term.';
  end if;
  select t.* into v_term from public.terms t where t.id = v_terms[1] and t.status = 'published';
  if not found then
    raise exception 'This term is not open for enrolment';
  end if;

  select string_agg(g.name, ', ' order by g.position) into v_double
  from public.term_slot_groups g
  where g.term_id = v_term.id
    and (select count(*) from public.term_slots ts where ts.id = any(p_slot_ids) and ts.group_id = g.id) > 1;
  if v_double is not null then
    raise exception 'Pick only one slot from each group (more than one picked in: %).', v_double;
  end if;
  select string_agg(g.name, ', ' order by g.position) into v_missing
  from public.term_slot_groups g
  where g.term_id = v_term.id
    and not exists (select 1 from public.term_slots ts where ts.id = any(p_slot_ids) and ts.group_id = g.id);
  if v_missing is not null then
    raise exception 'Pick one slot from each group (nothing picked in: %).', v_missing;
  end if;

  for v_a, v_b in
    select a, b from unnest(p_slot_ids) a, unnest(p_slot_ids) b where a < b
  loop
    if public.term_slots_overlap(v_a, v_b) then
      raise exception 'Two of those slots run at the same time. Pick a different combination.';
    end if;
  end loop;
  return v_term.id;
end;
$$;

-- What a combination costs right now. The price is the term's price for the
-- whole combination (a single-group term keeps the slot's own price, as
-- before); the mid-term reduction counts every session already run in any of
-- the chosen slots.
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
  v_price := case when v_term.reduce_enabled
                  then greatest(0, v_base - v_term.reduce_by_cents * v_passed)
                  else v_base end;
  return query select v_total, v_passed, v_left, v_ok, v_price, v_reason;
end;
$$;

-- =============================================================
-- 4. Enrol: the 00261 function becomes an internal one-slot step
-- =============================================================
-- enrol_in_term_core is 00261's enrol_in_term with two additions, marked
-- 00264: an exact price for the slot (the combination's share, chosen by
-- enrol_in_term_combo, never by the caller) and the combination id. Nobody
-- can call it directly; enrol_in_term and enrol_in_term_combo wrap it.
create or replace function public.enrol_in_term_core(
  p_slot_id    uuid,
  p_child_id   uuid,
  p_policies   uuid[],
  p_medical    text,
  p_info       text,
  p_group_id   uuid,
  p_price_cents int,
  p_combo_id   uuid
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

  if p_price_cents is not null then
    -- 00264: this slot's share of a combination's price, already worked out
    -- (sibling discount included) by enrol_in_term_combo.
    v_price := p_price_cents;
  else
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
  end if;

  v_group := gen_random_uuid();
  if p_group_id is not null then
    -- 00264: a combination's own checkout group was just made (or checked) by
    -- enrol_in_term_combo; this check is for a sibling joining a checkout.
    if p_combo_id is null and not exists (
      select 1 from public.term_enrolments e
      join public.bookings b on b.term_enrolment_id = e.id
      where e.booking_group_id = p_group_id and e.user_id = v_user and e.term_id = v_term.id
        and b.status = 'pending' and b.payment_status = 'none'
    ) then
      raise exception 'That checkout has expired. Start the enrolment again.';
    end if;
    v_group := p_group_id;
  end if;
  insert into public.term_enrolments (term_id, slot_id, provider_id, user_id, child_id, price_cents, sessions, booking_group_id, combo_id)
  values (v_term.id, p_slot_id, v_term.provider_id, v_user, v_child, v_price, v_left, v_group, p_combo_id)
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
  from public.bookings b where b.term_enrolment_id = v_enrol;

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

-- The one-slot entry point, as before — for a term with a single group.
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
begin
  if (select count(*) from public.term_slot_groups g
       where g.term_id = (select ts.term_id from public.term_slots ts where ts.id = p_slot_id)) > 1 then
    raise exception 'This term needs one slot from each group. Pick your full combination.';
  end if;
  return query select * from public.enrol_in_term_core(
    p_slot_id, p_child_id, p_policies, p_medical, p_info, p_group_id, null, null);
end;
$$;

-- Enrol a child in a whole combination: one slot from each group, every
-- remaining session of each, all or nothing. A term with one group may use
-- this too (a combination of one slot).
create or replace function public.enrol_in_term_combo(
  p_slot_ids  uuid[],
  p_child_id  uuid default null,
  p_policies  uuid[] default '{}',
  p_medical   text default null,
  p_info      text default null,
  p_group_id  uuid default null
)
returns table (combo_id uuid, group_id uuid, status text, price_cents int, sessions int, enrolment_ids uuid[])
language plpgsql
security definer
set search_path to 'public'
as $$
#variable_conflict use_column
declare
  v_user     uuid := auth.uid();
  v_term     public.terms;
  v_child    uuid;
  v_quote    record;
  v_price    int;
  v_prev     record;
  v_sorted   uuid[];
  v_slot     uuid;
  v_left_i   int;
  v_total    int;
  v_share    int;
  v_alloc    int := 0;
  v_i        int := 0;
  v_n        int;
  v_combo    uuid := gen_random_uuid();
  v_group    uuid := p_group_id;
  v_r        record;
  v_ids      uuid[] := '{}';
  v_sessions int := 0;
  v_status   text := 'confirmed';
begin
  if v_user is null then
    raise exception 'Please log in again to enrol';
  end if;
  select t.* into v_term from public.terms t where t.id = public.term_combo_check(p_slot_ids);

  if p_child_id is not null then
    select c.id into v_child from public.children c where c.id = p_child_id and c.parent_id = v_user;
    if v_child is null then
      raise exception 'That child is no longer on your profile — pick another';
    end if;
  end if;
  select array_agg(x order by x) into v_sorted from unnest(p_slot_ids) x;
  v_n := array_length(v_sorted, 1);

  -- An unpaid attempt at this very combination: hand it back.
  select e.combo_id, min(e.booking_group_id::text)::uuid as booking_group_id,
         sum(e.price_cents)::int as price_cents, sum(e.sessions)::int as sessions,
         array_agg(e.id order by e.slot_id) as ids
    into v_prev
  from public.term_enrolments e
  where e.user_id = v_user and e.term_id = v_term.id and e.combo_id is not null
    and e.child_id is not distinct from v_child
    and exists (select 1 from public.bookings b
                where b.term_enrolment_id = e.id and b.status = 'pending' and b.payment_status = 'none')
  group by e.combo_id
  having array_agg(e.slot_id order by e.slot_id) = v_sorted
  limit 1;
  if v_prev.combo_id is not null then
    if p_group_id is null or v_prev.booking_group_id = p_group_id then
      return query select v_prev.combo_id, v_prev.booking_group_id, 'pending'::text, v_prev.price_cents, v_prev.sessions, v_prev.ids;
      return;
    end if;
    -- Joining a sibling's checkout while holding an abandoned one: release it.
    update public.bookings
       set status = 'cancelled'
     where term_enrolment_id = any (v_prev.ids) and status = 'pending' and payment_status = 'none';
  end if;

  -- An abandoned unpaid attempt at a different combination is let go, as a
  -- sibling's checkout does for a single slot (nothing was paid, so nothing is
  -- owed back).
  update public.bookings
     set status = 'cancelled'
   where status = 'pending' and payment_status = 'none'
     and term_enrolment_id in (
       select e.id from public.term_enrolments e
       where e.user_id = v_user and e.term_id = v_term.id and e.combo_id is not null
         and e.child_id is not distinct from v_child);

  -- A child holds one combination per term.
  if exists (
    select 1 from public.term_enrolments e
    join public.bookings b on b.term_enrolment_id = e.id
    where e.user_id = v_user and e.term_id = v_term.id
      and e.child_id is not distinct from v_child
      and b.status in ('confirmed', 'pending')
  ) then
    raise exception 'This child is already enrolled in this term.';
  end if;

  if p_group_id is not null and not exists (
    select 1 from public.term_enrolments e
    join public.bookings b on b.term_enrolment_id = e.id
    where e.booking_group_id = p_group_id and e.user_id = v_user and e.term_id = v_term.id
      and b.status = 'pending' and b.payment_status = 'none'
  ) then
    raise exception 'That checkout has expired. Start the enrolment again.';
  end if;

  select * into v_quote from public.term_combo_quote(p_slot_ids);
  if not v_quote.joinable then
    raise exception '%', coalesce(v_quote.reason, 'This term is not open for enrolment');
  end if;

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
  v_total := v_quote.sessions_left;

  -- Each slot's share of the price follows its remaining sessions; the odd
  -- cents land on the last slot so the shares add up to exactly the price.
  foreach v_slot in array v_sorted loop
    v_i := v_i + 1;
    select q.sessions_left into v_left_i from public.term_quote(v_slot) q;
    v_share := case when v_i = v_n then v_price - v_alloc
                    else floor(v_price * v_left_i::numeric / greatest(v_total, 1))::int end;
    v_alloc := v_alloc + v_share;

    select * into v_r from public.enrol_in_term_core(
      v_slot, p_child_id, p_policies, p_medical, p_info, v_group, v_share, v_combo);
    v_group := v_r.group_id;
    v_ids := v_ids || v_r.enrolment_id;
    v_sessions := v_sessions + v_r.sessions;
    if v_r.status = 'pending' then v_status := 'pending'; end if;
  end loop;

  return query select v_combo, v_group, v_status, v_price, v_sessions, v_ids;
end;
$$;

-- =============================================================
-- 5. Waiting for a combination
-- =============================================================
create or replace function public.join_term_combo_waitlist(
  p_slot_ids uuid[],
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
#variable_conflict use_column
declare
  v_user   uuid := auth.uid();
  v_term   public.terms;
  v_act    record;
  v_child  uuid;
  v_quote  record;
  v_sorted uuid[];
  v_live   record;
  v_combo  uuid := gen_random_uuid();
  v_slot   uuid;
  v_full   uuid[] := '{}';
  v_first  timestamptz;
begin
  if v_user is null then
    raise exception 'Please log in again to join the waitlist';
  end if;
  select t.* into v_term from public.terms t where t.id = public.term_combo_check(p_slot_ids);
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

  select * into v_quote from public.term_combo_quote(p_slot_ids);
  if not v_quote.joinable then
    raise exception '%', coalesce(v_quote.reason, 'This term is not open for enrolment');
  end if;

  if exists (
    select 1 from public.term_enrolments e
    join public.bookings b on b.term_enrolment_id = e.id
    where e.user_id = v_user and e.term_id = v_term.id
      and e.child_id is not distinct from v_child
      and b.status in ('confirmed', 'pending')
  ) then
    raise exception 'This child is already enrolled in this term.';
  end if;

  select array_agg(x order by x) into v_sorted from unnest(p_slot_ids) x;

  -- Already waiting: the same combination returns its entry; a different one
  -- has to be left first.
  select w.combo_id, (select array_agg(x order by x) from unnest(w.combo_slot_ids) x) as slots into v_live
  from public.term_waitlist w
  where w.term_id = v_term.id and w.user_id = v_user
    and w.child_id is not distinct from v_child
    and w.status in ('waiting', 'holding') and w.combo_id is not null
  limit 1;
  if v_live.combo_id is not null then
    if v_live.slots = v_sorted then
      return v_live.combo_id;
    end if;
    raise exception 'This child is already waiting for a different combination in this term. Leave that waitlist first.';
  end if;

  foreach v_slot in array v_sorted loop
    if public.term_slot_free_places(v_slot) <= 0 then
      v_full := v_full || v_slot;
    end if;
  end loop;
  if coalesce(array_length(v_full, 1), 0) = 0 then
    raise exception 'Every slot you picked has a free place. Enrol now instead.';
  end if;

  foreach v_slot in array v_full loop
    insert into public.term_waitlist
      (term_id, slot_id, provider_id, user_id, child_id, policies_accepted, medical_disclosure, info_response,
       position, combo_id, combo_slot_ids)
    values (
      v_term.id, v_slot, v_term.provider_id, v_user, v_child, coalesce(p_policies, '{}'::uuid[]),
      nullif(btrim(p_medical), ''), nullif(btrim(p_info), ''),
      (select coalesce(max(w.position), 0) + 1 from public.term_waitlist w where w.slot_id = v_slot),
      v_combo, v_sorted
    );
  end loop;

  select min(s.starts_at) into v_first
  from public.activity_sessions s
  where s.term_slot_id = any (v_sorted) and s.status is distinct from 'cancelled' and s.starts_at > now();

  insert into public.notifications (user_id, type, title, body, data)
  values (
    v_user,
    'term_waitlist_joined',
    'You''re on the waitlist for ' || v_term.name,
    'We''ll email you when every slot of your combination has a place. Joining is free.',
    jsonb_build_object(
      'url', '/profile?tab=bookings',
      'term_name', v_term.name,
      'activity_name', v_act.title,
      'child_name', (select c.name from public.children c where c.id = v_child),
      'slot_id', v_full[1],
      'slot_ids', to_jsonb(v_sorted),
      'combo_id', v_combo,
      'first_session', to_char(v_first at time zone 'Asia/Singapore', 'Dy FMDD Mon, FMHH12:MI am'),
      'reduce_by_cents', case when v_term.reduce_enabled then v_term.reduce_by_cents else 0 end
    )
  );
  return v_combo;
end;
$$;

-- One "someone joined" message to the vendor for a whole combination.
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
  -- 00264: one message per combination, not one per full slot.
  if new.combo_id is not null and exists (
    select 1 from public.term_waitlist w where w.combo_id = new.combo_id and w.id <> new.id
  ) then
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

-- =============================================================
-- 6. Telling the families waiting
-- =============================================================
-- 00260's function. A single-slot entry is told as before. A combination is
-- told only when EVERY one of its slots has a free place, and the message is
-- about the whole combination. It is considered when ANY of its slots frees a
-- place, not only the slot it was waiting on.
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
  v_cq     record;
  v_first  timestamptz;
  v_price  text;
  v_told   uuid[] := '{}';
  v_ok     boolean;
  r        record;
begin
  -- Most slots have nobody waiting: nothing else to work out.
  if not exists (
    select 1 from public.term_waitlist w
    where w.status = 'waiting'
      and ((w.combo_id is null and w.slot_id = p_slot_id)
           or (w.combo_id is not null and p_slot_id = any (w.combo_slot_ids)))
  ) then
    return;
  end if;
  -- One event can call this once per seat it frees; tell people once.
  if exists (
    select 1 from public.term_waitlist w
    where w.last_told_at = now()
      and ((w.combo_id is null and w.slot_id = p_slot_id)
           or (w.combo_id is not null and p_slot_id = any (w.combo_slot_ids)))
  ) then
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

  -- One message per family, even with two children waiting.
  for r in
    select distinct on (w.user_id) w.id, w.user_id, w.child_id, w.combo_id, w.combo_slot_ids
    from public.term_waitlist w
    where w.status = 'waiting'
      and ((w.combo_id is null and w.slot_id = p_slot_id)
           or (w.combo_id is not null and p_slot_id = any (w.combo_slot_ids)))
    order by w.user_id, w.position
  loop
    if r.combo_id is null then
      select min(s.starts_at) into v_first
      from public.activity_sessions s
      where s.term_slot_id = p_slot_id
        and s.status is distinct from 'cancelled'
        and s.starts_at - make_interval(mins => coalesce(s.booking_cutoff_minutes, v_act.cutoff)) > now();
      v_price := '$' || case when v_quote.price_cents % 100 = 0 then (v_quote.price_cents / 100)::text
                             else to_char(v_quote.price_cents / 100.0, 'FM999990.00') end;
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
      v_told := v_told || r.id;
    else
      -- A combination: every slot must have a place, and the whole thing must
      -- still be joinable.
      v_ok := not exists (select 1 from unnest(r.combo_slot_ids) x where public.term_slot_free_places(x) <= 0);
      if v_ok then
        begin
          select * into v_cq from public.term_combo_quote(r.combo_slot_ids);
          v_ok := v_cq.joinable;
        exception when others then
          v_ok := false;
        end;
      end if;
      if v_ok then
        select min(s.starts_at) into v_first
        from public.activity_sessions s
        where s.term_slot_id = any (r.combo_slot_ids)
          and s.status is distinct from 'cancelled'
          and s.starts_at - make_interval(mins => coalesce(s.booking_cutoff_minutes, v_act.cutoff)) > now();
        v_price := '$' || case when v_cq.price_cents % 100 = 0 then (v_cq.price_cents / 100)::text
                               else to_char(v_cq.price_cents / 100.0, 'FM999990.00') end;
        insert into public.notifications (user_id, type, title, body, data)
        values (
          r.user_id,
          'term_waitlist_place_open',
          'Your places are free in ' || v_term.name,
          'Every slot of the combination you were waiting for has a place in ' || v_term.name
            || ' (' || coalesce(v_act.title, 'your class') || '): '
            || v_cq.sessions_left || ' sessions from '
            || to_char(v_first at time zone 'Asia/Singapore', 'Dy FMDD Mon') || ', ' || v_price
            || '. The first family to enrol gets them. You haven''t been charged anything.',
          jsonb_build_object(
            'url', '/book?slug=' || coalesce(v_act.slug, '') || '&term_slots=' || array_to_string(r.combo_slot_ids, ',')
                   || '&mode=term' || coalesce('&child=' || r.child_id, ''),
            'term_name', v_term.name,
            'activity_name', v_act.title,
            'slot_id', p_slot_id,
            'slot_ids', to_jsonb(r.combo_slot_ids),
            'combo_id', r.combo_id,
            'entry_id', r.id,
            'sessions_left', v_cq.sessions_left,
            'price_cents', v_cq.price_cents,
            'first_session', to_char(v_first at time zone 'Asia/Singapore', 'Dy FMDD Mon, FMHH12:MI am')
          )
        );
        v_told := v_told || r.id;
      end if;
    end if;
  end loop;

  -- Mark every entry of a family that was told, so one event tells them once.
  update public.term_waitlist w set last_told_at = now()
  where w.status = 'waiting'
    and ((w.combo_id is null and w.slot_id = p_slot_id)
         or w.id = any (v_told)
         or (w.combo_id is not null and w.combo_id in (select w2.combo_id from public.term_waitlist w2 where w2.id = any (v_told))));
end;
$$;

-- The vendor's personal offer (00261), for a combination as well.
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
  v_slots uuid[];
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
  v_slots := coalesce(v_w.combo_slot_ids, array[v_w.slot_id]);
  if v_w.combo_id is null then
    select * into v_quote from public.term_quote(v_w.slot_id);
  else
    select * into v_quote from public.term_combo_quote(v_slots);
  end if;
  if not v_quote.joinable then
    raise exception '%', coalesce(v_quote.reason, 'This term is not open for enrolment');
  end if;
  select a.title, a.slug, coalesce(a.booking_cutoff_minutes, 15) as cutoff into v_act
  from public.activities a where a.id = v_term.activity_id;
  select min(s.starts_at) into v_first
  from public.activity_sessions s
  where s.term_slot_id = any (v_slots) and s.status is distinct from 'cancelled'
    and s.starts_at - make_interval(mins => coalesce(s.booking_cutoff_minutes, v_act.cutoff)) > now();
  v_price := '$' || case when v_quote.price_cents % 100 = 0 then (v_quote.price_cents / 100)::text
                         else to_char(v_quote.price_cents / 100.0, 'FM999990.00') end;
  select c.name into v_child from public.children c where c.id = v_w.child_id;
  select coalesce(nullif(btrim(p.business_name), ''), 'The provider') into v_who
  from public.providers p where p.id = v_w.provider_id;

  -- A combination is offered whole: every entry of it may go over capacity.
  update public.term_waitlist set vendor_offered = true
  where id = p_entry_id or (v_w.combo_id is not null and combo_id = v_w.combo_id and status = 'waiting');

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
      'url', case when v_w.combo_id is null
                  then '/book?slug=' || coalesce(v_act.slug, '') || '&term_slot=' || v_w.slot_id || '&mode=term&offered=1'
                  else '/book?slug=' || coalesce(v_act.slug, '') || '&term_slots=' || array_to_string(v_slots, ',') || '&mode=term&offered=1'
             end || coalesce('&child=' || v_w.child_id, ''),
      'provider_name', v_who,
      'term_name', v_term.name,
      'activity_name', v_act.title,
      'child_name', v_child,
      'slot_id', v_w.slot_id,
      'slot_ids', to_jsonb(v_slots),
      'combo_id', v_w.combo_id,
      'entry_id', v_w.id,
      'sessions_left', v_quote.sessions_left,
      'price_cents', v_quote.price_cents,
      'first_session', to_char(v_first at time zone 'Asia/Singapore', 'Dy FMDD Mon, FMHH12:MI am')
    )
  );
end;
$$;

-- Leaving (00261's function): a combination goes as a whole, seats and all.
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
   where id = p_entry_id
      or (v_w.combo_id is not null and combo_id = v_w.combo_id and status in ('waiting', 'holding'));
  if v_w.status = 'holding' and v_w.hold_enrolment_id is not null then
    -- Unpaid seats only (of every slot of a combination). Their trigger offers
    -- the places to everyone else.
    update public.bookings
       set status = 'cancelled'
     where status = 'pending' and payment_status = 'none'
       and term_enrolment_id in (
         select e.id from public.term_enrolments e
         where e.id = v_w.hold_enrolment_id
            or (e.combo_id is not null
                and e.combo_id = (select e3.combo_id from public.term_enrolments e3 where e3.id = v_w.hold_enrolment_id))
       );
  end if;
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
   where id = p_entry_id
      or (v_w.combo_id is not null and combo_id = v_w.combo_id and status in ('waiting', 'holding'));
  if v_w.status = 'holding' and v_w.hold_enrolment_id is not null then
    update public.bookings
       set status = 'cancelled', cancel_reason = 'Removed from the waitlist', cancelled_by = auth.uid()
     where status = 'pending' and payment_status = 'none'
       and term_enrolment_id in (
         select e.id from public.term_enrolments e
         where e.id = v_w.hold_enrolment_id
            or (e.combo_id is not null
                and e.combo_id = (select e3.combo_id from public.term_enrolments e3 where e3.id = v_w.hold_enrolment_id))
       );
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

-- The parent's Bookings tab (00261's columns plus the combination). A
-- combination shows as one card: slot_id is one of its slots, combo_slot_ids
-- lists them all, and the numbers are the whole combination's.
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
  created_at         timestamptz,
  combo_id           uuid,
  combo_slot_ids     uuid[]
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
  ),
  singles as (
    select l.* from live l where l.combo_id is null
  ),
  combos as (
    select distinct on (l.combo_id) l.* from live l where l.combo_id is not null
    order by l.combo_id, l.position, l.id
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
         l.created_at,
         null::uuid, null::uuid[]
  from singles l
  left join public.children c on c.id = l.child_id
  cross join lateral public.term_quote(l.slot_id) q
  union all
  select l.id, l.status, l.slot_id, l.term_name, l.activity_title, l.slug, l.child_id, c.name,
         (select min(s.starts_at) from public.activity_sessions s
           where s.term_slot_id = any (l.combo_slot_ids) and s.status is distinct from 'cancelled' and s.starts_at > now()),
         q.sessions_left, q.price_cents, q.joinable,
         (select min(public.term_slot_free_places(x)) from unnest(l.combo_slot_ids) x)::int,
         false,
         l.vendor_offered,
         l.created_at,
         l.combo_id, l.combo_slot_ids
  from combos l
  left join public.children c on c.id = l.child_id
  cross join lateral public.term_combo_quote(l.combo_slot_ids) q
  order by 16 desc;
end;
$$;

-- =============================================================
-- 7. Withdrawing takes the whole combination
-- =============================================================
-- 00263's parent function.
create or replace function public.withdraw_from_term(p_enrolment_id uuid)
returns int
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_user    uuid := auth.uid();
  v_e       public.term_enrolments;
  v_ids     uuid[];
  v_slots   uuid[];
  v_allow   boolean;
  v_cut     int;
  v_mode    text;
  v_started boolean;
  v_n       int;
  v_slot    uuid;
begin
  if v_user is null then raise exception 'Not authenticated'; end if;
  select * into v_e from public.term_enrolments where id = p_enrolment_id and user_id = v_user;
  if not found then raise exception 'That enrolment was not found.'; end if;

  -- 00264: a combination is withdrawn whole (a parent cannot drop one slot).
  select array_agg(e.id), array_agg(e.slot_id) into v_ids, v_slots
  from public.term_enrolments e
  where e.user_id = v_user
    and (e.id = p_enrolment_id or (v_e.combo_id is not null and e.combo_id = v_e.combo_id));

  select a.allow_cancellation, a.cancellation_cutoff_hours, a.cancellation_refund_mode
    into v_allow, v_cut, v_mode
  from public.terms t join public.activities a on a.id = t.activity_id
  where t.id = v_e.term_id;
  if not coalesce(v_allow, true) then
    raise exception 'The provider does not allow cancellations for this class. Contact them to withdraw.';
  end if;

  -- Started = a session of the group has passed its booking window (the
  -- moment term_quote counts it as run).
  select coalesce(bool_or((select q.sessions_passed > 0 from public.term_quote(x) q)), false)
    into v_started from unnest(v_slots) x;

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
  -- 00260: a whole place may now be free (in every slot of the combination).
  foreach v_slot in array v_slots loop
    perform public.offer_term_place(v_slot);
  end loop;
  return v_n;
end;
$$;

-- 00260's vendor function.
create or replace function public.vendor_withdraw_from_term(p_enrolment_id uuid, p_refund_mode text, p_reason text default null)
returns int
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_e     public.term_enrolments;
  v_ids   uuid[];
  v_slots uuid[];
  v_slot  uuid;
  v_n     int;
begin
  select * into v_e from public.term_enrolments where id = p_enrolment_id;
  if not found or v_e.provider_id not in (select public.user_manage_provider_ids()) then
    raise exception 'not authorized';
  end if;
  if p_refund_mode not in ('refund', 'none') then
    raise exception 'Choose refund or no refund.';
  end if;

  select array_agg(e.id), array_agg(e.slot_id) into v_ids, v_slots
  from public.term_enrolments e
  where e.id = p_enrolment_id or (v_e.combo_id is not null and e.combo_id = v_e.combo_id);

  update public.bookings b
     set status = 'cancelled',
         cancel_refund_mode = p_refund_mode,
         cancel_reason = nullif(btrim(p_reason), ''),
         cancelled_by = auth.uid()
    from public.activity_sessions s
   where s.id = b.session_id
     and b.term_enrolment_id = any (v_ids)
     and b.status in ('pending', 'confirmed', 'waitlisted')
     and s.starts_at > now();
  get diagnostics v_n = row_count;
  -- 00260: a whole place may now be free.
  foreach v_slot in array v_slots loop
    perform public.offer_term_place(v_slot);
  end loop;
  return v_n;
end;
$$;

-- =============================================================
-- 8. The vendor swaps a family to another slot of the same group
-- =============================================================
-- Moves the enrolment's remaining bookings, session for session (the Nth
-- session of the old slot becomes the Nth of the new one), keeping what was
-- paid. Refuses when the new slot has no matching session, is full on one,
-- would clash with another slot in the family's combination, or the child
-- already holds a seat on one of the sessions. Sessions already run stay where
-- they were. The place the family leaves is offered to anyone waiting.
create or replace function public.vendor_swap_term_slot(p_enrolment_id uuid, p_new_slot_id uuid)
returns int
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_e      public.term_enrolments;
  v_old    public.term_slots;
  v_new    public.term_slots;
  v_term   public.terms;
  v_other  uuid;
  r        record;
  v_target uuid;
  v_cap    int;
  v_taken  int;
  v_n      int := 0;
begin
  select * into v_e from public.term_enrolments where id = p_enrolment_id for update;
  if not found or v_e.provider_id not in (select public.user_manage_provider_ids()) then
    raise exception 'not authorized';
  end if;
  select * into v_old from public.term_slots where id = v_e.slot_id;
  select * into v_new from public.term_slots where id = p_new_slot_id for update;
  if not found then
    raise exception 'That slot does not exist.';
  end if;
  select * into v_term from public.terms where id = v_e.term_id;
  if v_term.status <> 'published' then
    raise exception 'This term is not running.';
  end if;
  if v_new.id = v_old.id then
    raise exception 'They are already in that slot.';
  end if;
  if v_new.term_id <> v_old.term_id or v_new.group_id is distinct from v_old.group_id then
    raise exception 'A family can only move to another slot of the same group.';
  end if;

  -- The other slots of their combination must not clash with the new one.
  for v_other in
    select e.slot_id from public.term_enrolments e
    where e.combo_id is not null and e.combo_id = v_e.combo_id and e.id <> v_e.id
  loop
    if public.term_slots_overlap(v_new.id, v_other) then
      raise exception 'The new slot runs at the same time as another slot in this family''s combination.';
    end if;
  end loop;

  for r in
    select b.id as booking_id, b.child_id, b.user_id, s.term_session_no, s.id as old_session
    from public.bookings b
    join public.activity_sessions s on s.id = b.session_id
    where b.term_enrolment_id = p_enrolment_id
      and b.status in ('pending', 'confirmed')
      and s.starts_at > now()
    order by s.starts_at
  loop
    v_target := null;
    select s2.id into v_target
    from public.activity_sessions s2
    where s2.term_slot_id = v_new.id and s2.term_session_no = r.term_session_no
      and s2.status is distinct from 'cancelled' and s2.starts_at > now()
    for update;
    if v_target is null then
      raise exception 'The new slot has no matching session for session % of the term.', r.term_session_no;
    end if;
    select s2.capacity into v_cap from public.activity_sessions s2 where s2.id = v_target;
    select count(*) into v_taken from public.bookings b2
    where b2.session_id = v_target and b2.status in ('pending', 'confirmed');
    if v_cap is not null and v_taken >= v_cap then
      raise exception 'The new slot is full on session % of the term.', r.term_session_no;
    end if;
    if exists (select 1 from public.bookings b3
               where b3.session_id = v_target and b3.status in ('pending', 'confirmed')
                 and ((r.child_id is not null and b3.child_id = r.child_id)
                      or (r.child_id is null and b3.child_id is null and b3.user_id = r.user_id))) then
      raise exception 'The child already has a place on session % of the new slot.', r.term_session_no;
    end if;
    update public.bookings set session_id = v_target where id = r.booking_id;
    v_n := v_n + 1;
  end loop;
  if v_n = 0 then
    raise exception 'There are no sessions left to move.';
  end if;

  update public.term_enrolments set slot_id = v_new.id where id = p_enrolment_id;

  insert into public.notifications (user_id, type, title, body, data)
  select v_e.user_id, 'term_slot_changed', 'Your slot in ' || v_term.name || ' has changed',
         coalesce(nullif(btrim(p.business_name), ''), 'The provider') || ' has moved '
           || coalesce((select c.name from public.children c where c.id = v_e.child_id), 'your child')
           || ' to a different slot in ' || v_term.name || ' (' || a.title || '). Their remaining sessions have moved with them; nothing more to pay.',
         jsonb_build_object('url', '/profile?tab=bookings', 'term_name', v_term.name, 'activity_name', a.title,
                            'old_slot_id', v_old.id, 'new_slot_id', v_new.id, 'sessions_moved', v_n)
  from public.providers p, public.activities a
  where p.id = v_e.provider_id and a.id = v_term.activity_id;

  -- The place the family left is free again.
  perform public.offer_term_place(v_old.id);
  return v_n;
end;
$$;

-- =============================================================
-- 9. Who may call what
-- =============================================================
revoke all on function public.term_slot_set_group() from public, anon, authenticated;
revoke all on function public.term_slot_group_guard() from public, anon, authenticated;
revoke all on function public.term_publish_groups_check() from public, anon, authenticated;
revoke all on function public.term_waitlist_entry_guard() from public, anon, authenticated;
revoke all on function public.term_waitlist_end_combo() from public, anon, authenticated;
revoke all on function public.term_slots_overlap(uuid, uuid) from public, anon, authenticated;
revoke all on function public.term_combo_check(uuid[]) from public, anon, authenticated;
revoke all on function public.enrol_in_term_core(uuid, uuid, uuid[], text, text, uuid, int, uuid) from public, anon, authenticated;

-- Like term_quote: only a published term's public numbers, so logged-out pages may ask.
revoke all on function public.term_combo_quote(uuid[]) from public;
grant execute on function public.term_combo_quote(uuid[]) to anon, authenticated;

revoke all on function public.enrol_in_term(uuid, uuid, uuid[], text, text, uuid) from public, anon;
grant execute on function public.enrol_in_term(uuid, uuid, uuid[], text, text, uuid) to authenticated;
revoke all on function public.enrol_in_term_combo(uuid[], uuid, uuid[], text, text, uuid) from public, anon;
grant execute on function public.enrol_in_term_combo(uuid[], uuid, uuid[], text, text, uuid) to authenticated;
revoke all on function public.join_term_combo_waitlist(uuid[], uuid, uuid[], text, text) from public, anon;
grant execute on function public.join_term_combo_waitlist(uuid[], uuid, uuid[], text, text) to authenticated;
revoke all on function public.vendor_swap_term_slot(uuid, uuid) from public, anon;
grant execute on function public.vendor_swap_term_slot(uuid, uuid) to authenticated;

revoke all on function public.notify_provider_term_waitlist_joined() from public, anon, authenticated;
revoke all on function public.offer_term_place(uuid) from public, anon, authenticated;
revoke all on function public.vendor_offer_term_place(uuid) from public, anon;
grant execute on function public.vendor_offer_term_place(uuid) to authenticated;
revoke all on function public.leave_term_waitlist_entry(uuid) from public, anon;
grant execute on function public.leave_term_waitlist_entry(uuid) to authenticated;
revoke all on function public.vendor_remove_from_term_waitlist(uuid, text) from public, anon;
grant execute on function public.vendor_remove_from_term_waitlist(uuid, text) to authenticated;
revoke all on function public.my_term_waitlist() from public, anon;
grant execute on function public.my_term_waitlist() to authenticated;
revoke all on function public.withdraw_from_term(uuid) from public, anon;
grant execute on function public.withdraw_from_term(uuid) to authenticated;
revoke all on function public.vendor_withdraw_from_term(uuid, text, text) from public, anon;
grant execute on function public.vendor_withdraw_from_term(uuid, text, text) to authenticated;

notify pgrst, 'reload schema';

commit;
