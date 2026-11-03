-- 00269_term_waitlist_pairs_and_used_trials.sql
--
-- Two gaps found when the client read the term waitlist write-up (3 Nov 2026):
--
--   1. Flexible terms: a family can wait for SEVERAL pairs of slots, not just
--      one. When they get into one pair, their Bookings page asks whether to
--      stay on the others (leaving is the suggested choice), as it already does
--      for a family waiting on two slots of a Simple term. A child may also
--      hold a second pair, as a child may hold two slots of a Simple term; a
--      slot the child already has a place in still can't be taken twice.
--        * term_waitlist: one live entry per child per slot is now only for
--          one-slot entries; pair entries are unique per slot AND pair.
--        * join_term_combo_waitlist: a different pair is no longer refused.
--        * enrol_in_term_core takes the pair being enrolled, so it holds the
--          waiting entry for THAT pair, not another pair on the same slot.
--        * enrol_in_term_combo: no "one pair per term" rule; an abandoned
--          unpaid attempt is only let go when it shares a slot with this one.
--        * offer_term_place: a family whose first pair still has a full slot
--          is told about another of their pairs that is ready.
--        * my_term_waitlist: enrolled_elsewhere is now worked out for pairs.
--   2. Trials: a child waiting for a trial session who then uses their trial
--      on another session (one with room) no longer stays on the trial
--      waitlist. Once that trial is confirmed, their other trial waits with the
--      same vendor close and the family is told, with the next step: book the
--      session as a single when the term sells singles, or enrol in the whole
--      term when it doesn't. "Pay now" on such a place (only possible while
--      the other trial is still unpaid) says the same.
--
-- Term-only: ordinary classes and bookings are not touched (the new trigger
-- only runs for trial bookings on term sessions).
--
-- Idempotent.

begin;

-- =============================================================
-- 1. Waitlist entries: several pairs per child
-- =============================================================
drop index if exists public.term_waitlist_one_live_per_child;
create unique index term_waitlist_one_live_per_child
  on public.term_waitlist (slot_id, user_id, coalesce(child_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where status in ('waiting', 'holding') and combo_id is null;
drop index if exists public.term_waitlist_one_live_per_pair_slot;
create unique index term_waitlist_one_live_per_pair_slot
  on public.term_waitlist (slot_id, user_id, coalesce(child_id, '00000000-0000-0000-0000-000000000000'::uuid), combo_slot_ids)
  where status in ('waiting', 'holding') and combo_id is not null;

-- =============================================================
-- 2. Enrolling: the waiting entry for the pair being enrolled
-- =============================================================
-- 00264's function with the pair passed in (p_combo_slots, sorted), marked 00269.
drop function if exists public.enrol_in_term_core(uuid, uuid, uuid[], text, text, uuid, int, uuid);
create or replace function public.enrol_in_term_core(
  p_slot_id    uuid,
  p_child_id   uuid,
  p_policies   uuid[],
  p_medical    text,
  p_info       text,
  p_group_id   uuid,
  p_price_cents int,
  p_combo_id   uuid,
  p_combo_slots uuid[] default null
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
  -- 00269: a family may wait on this slot for several pairs; only the entry
  -- for the pair being enrolled (or a one-slot entry) is taken.
  select w.id, w.vendor_offered into v_wait, v_offered from public.term_waitlist w
  where w.slot_id = p_slot_id and w.user_id = v_user
    and w.child_id is not distinct from v_child
    and w.status = 'waiting'
    and (case when p_combo_slots is null then w.combo_id is null else w.combo_slot_ids = p_combo_slots end)
  limit 1
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

-- =============================================================
-- 3. Enrolling in a pair: a second pair is allowed
-- =============================================================
-- 00264's function, changes marked 00269.
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

  -- An abandoned unpaid attempt at a different pair that shares a slot with
  -- this one is let go, as a sibling's checkout does for a single slot (nothing
  -- was paid, so nothing is owed back). 00269: a pair that shares no slot is
  -- left alone: a child may hold two pairs, as a child may hold two slots of a
  -- Simple term.
  update public.bookings
     set status = 'cancelled'
   where status = 'pending' and payment_status = 'none'
     and term_enrolment_id in (
       select e.id from public.term_enrolments e
       where e.user_id = v_user and e.term_id = v_term.id and e.combo_id is not null
         and e.child_id is not distinct from v_child
         and exists (select 1 from public.term_enrolments e2
                     where e2.combo_id = e.combo_id and e2.slot_id = any (v_sorted)));

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
      v_slot, p_child_id, p_policies, p_medical, p_info, v_group, v_share, v_combo, v_sorted);
    v_group := v_r.group_id;
    v_ids := v_ids || v_r.enrolment_id;
    v_sessions := v_sessions + v_r.sessions;
    if v_r.status = 'pending' then v_status := 'pending'; end if;
  end loop;

  return query select v_combo, v_group, v_status, v_price, v_sessions, v_ids;
end;
$$;

-- =============================================================
-- 4. Waiting for several pairs
-- =============================================================
-- 00264's functions, changes marked 00269.
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

  -- 00269: only a slot the child already has a place in rules a pair out.
  if exists (
    select 1 from public.term_enrolments e
    join public.bookings b on b.term_enrolment_id = e.id
    where e.user_id = v_user and e.term_id = v_term.id
      and e.child_id is not distinct from v_child
      and e.slot_id = any (p_slot_ids)
      and b.status in ('confirmed', 'pending')
  ) then
    raise exception 'This child already has a place in one of these slots.';
  end if;

  select array_agg(x order by x) into v_sorted from unnest(p_slot_ids) x;

  -- Already waiting for this exact pair: the same entry. 00269: waiting for
  -- other pairs as well is fine; when the family gets into one, their
  -- Bookings page asks whether to stay on the others.
  select w.combo_id, w.combo_slot_ids as slots into v_live
  from public.term_waitlist w
  where w.term_id = v_term.id and w.user_id = v_user
    and w.child_id is not distinct from v_child
    and w.status in ('waiting', 'holding') and w.combo_id is not null
    and w.combo_slot_ids = v_sorted
  limit 1;
  if v_live.combo_id is not null then
    return v_live.combo_id;
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
  v_users  uuid[] := '{}';
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

  -- One message per family, even with two children (or two pairs) waiting.
  -- 00269: every entry is looked at, so a family whose first pair still has a
  -- full slot is told about another pair of theirs that is ready.
  for r in
    select w.id, w.user_id, w.child_id, w.combo_id, w.combo_slot_ids
    from public.term_waitlist w
    where w.status = 'waiting'
      and ((w.combo_id is null and w.slot_id = p_slot_id)
           or (w.combo_id is not null and p_slot_id = any (w.combo_slot_ids)))
    order by w.user_id, w.position
  loop
    continue when r.user_id = any (v_users);
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
      v_users := v_users || r.user_id;
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
      v_users := v_users || r.user_id;
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
         -- 00269: enrolled in another pair (a slot outside this one) of the same term.
         exists (select 1 from public.term_enrolments e
                 join public.bookings b on b.term_enrolment_id = e.id
                 where e.term_id = l.term_id and not (e.slot_id = any (l.combo_slot_ids))
                   and e.user_id = l.user_id and e.child_id is not distinct from l.child_id
                   and b.status in ('pending', 'confirmed')),
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
-- 5. "Pay now" on a trial place after the trial was used
-- =============================================================
-- 00259's function, the message changed (00269).
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
      -- 00269: only suggest a single session when the term sells them.
      if v_term.allow_singles then
        raise exception 'This child has already used their trial with this provider. Leave this waitlist place and book the session as a single instead.';
      end if;
      raise exception 'This child has already used their trial with this provider, and this term has no single sessions. Leave this waitlist place; you can enrol in the whole term instead.';
    end if;
  end loop;

  perform public.claim_waitlist_seats(p_seat_ids);
end;
$$;

-- =============================================================
-- 6. A used trial closes the family's other trial waits
-- =============================================================
create or replace function public.term_trial_used_close_waits()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_provider uuid;
  v_used     int;
  r          record;
begin
  select t.provider_id into v_provider
  from public.activity_sessions s
  join public.term_slots ts on ts.id = s.term_slot_id
  join public.terms t on t.id = ts.term_id
  where s.id = new.session_id;
  if v_provider is null then
    return null;
  end if;

  -- The trials this child has taken with the vendor (as term_session_gate counts them).
  select count(*) into v_used
  from public.bookings b
  join public.activity_sessions s2 on s2.id = b.session_id
  join public.term_slots ts2 on ts2.id = s2.term_slot_id
  join public.terms t2 on t2.id = ts2.term_id
  where b.term_booking_kind = 'trial'
    and t2.provider_id = v_provider
    and b.status not in ('cancelled', 'waitlisted')
    and ((new.child_id is not null and b.child_id = new.child_id)
         or (new.child_id is null and b.child_id is null and b.user_id = new.user_id));

  for r in
    select b.id, b.user_id, b.child_id, s.starts_at, t.name as term_name, t.trial_limit, t.allow_singles,
           a.title, a.slug, b.session_id
    from public.bookings b
    join public.activity_sessions s on s.id = b.session_id
    join public.term_slots ts on ts.id = s.term_slot_id
    join public.terms t on t.id = ts.term_id
    join public.activities a on a.id = t.activity_id
    where b.status = 'waitlisted' and b.term_booking_kind = 'trial'
      and t.provider_id = v_provider
      and b.id <> new.id
      and ((new.child_id is not null and b.child_id = new.child_id)
           or (new.child_id is null and b.child_id is null and b.user_id = new.user_id))
  loop
    continue when v_used < r.trial_limit;
    -- Left the way a parent leaves a waitlist place: nothing was paid.
    update public.bookings
       set status = 'cancelled', cancel_refund_mode = 'refund', cancel_reason = 'Trial already used'
     where id = r.id and status = 'waitlisted';
    insert into public.notifications (user_id, type, title, body, data)
    values (
      r.user_id,
      'term_trial_waitlist_closed',
      'Your trial waitlist place has closed',
      coalesce((select c.name from public.children c where c.id = r.child_id), 'Your child')
        || ' has now used their trial with this provider, so the waitlist place for a trial on '
        || to_char(r.starts_at at time zone 'Asia/Singapore', 'Dy FMDD Mon') || ' (' || coalesce(r.title, 'the class') || ') has closed. '
        || case when r.allow_singles
                then 'You can book that session as a single session instead.'
                else r.term_name || ' doesn''t offer single sessions, but you can enrol in the whole term.' end
        || ' You haven''t been charged anything.',
      jsonb_build_object(
        'url', case when r.allow_singles
                    then '/book?slug=' || coalesce(r.slug, '') || '&session=' || r.session_id || '&mode=single'
                    else '/book?slug=' || coalesce(r.slug, '') || '&mode=term' end,
        'term_name', r.term_name,
        'activity_name', r.title,
        'singles_offered', r.allow_singles
      )
    );
  end loop;
  return null;
end;
$$;

drop trigger if exists term_trial_used_close_waits on public.bookings;
create trigger term_trial_used_close_waits
  after insert or update of status on public.bookings
  for each row
  when (new.term_booking_kind = 'trial' and new.status = 'confirmed')
  execute function public.term_trial_used_close_waits();

-- =============================================================
-- 7. Who may call what
-- =============================================================
revoke all on function public.enrol_in_term_core(uuid, uuid, uuid[], text, text, uuid, int, uuid, uuid[]) from public, anon, authenticated;
revoke all on function public.enrol_in_term_combo(uuid[], uuid, uuid[], text, text, uuid) from public, anon;
grant execute on function public.enrol_in_term_combo(uuid[], uuid, uuid[], text, text, uuid) to authenticated;
revoke all on function public.join_term_combo_waitlist(uuid[], uuid, uuid[], text, text) from public, anon;
grant execute on function public.join_term_combo_waitlist(uuid[], uuid, uuid[], text, text) to authenticated;
revoke all on function public.offer_term_place(uuid) from public, anon, authenticated;
revoke all on function public.my_term_waitlist() from public, anon;
grant execute on function public.my_term_waitlist() to authenticated;
revoke all on function public.term_trial_used_close_waits() from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;
