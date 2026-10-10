-- 00232_event_waitlist_auto_promote.sql
--
-- Automatic promotion from an event waitlist (builds on 00231).
--
-- When seats free up in a slot - a confirmed party is cancelled or moved to the waitlist by an
-- admin, or the slot's capacity is raised - the waitlist is worked through in the order people
-- registered (oldest first) and every party that fits the free seats is confirmed. A party that
-- does not fit is skipped, not blocked on, so a smaller party behind it can still get the seats
-- (the same "keep the free seats open for whoever fits" rule as registration).
--
--   * An admin who puts someone on the waitlist by hand (or adds them there) is *holding* them:
--     `held` stops them being promoted automatically; an admin promotes them by hand.
--   * Every waitlist -> confirmed move (automatic or by hand) is stamped promoted_at, and
--     notified_at stays null until the "a spot opened up" email has gone, so nothing is missed
--     when an email fails (the admin Events page lists pending notifications and can resend).
--
-- promote_event_waitlist is internal: called by the status function below and by the capacity
-- trigger, and by the server routes with the service-role key. Not reachable by anon/authenticated.

alter table public.event_registrations
  add column if not exists held          boolean     not null default false,
  add column if not exists promoted_at   timestamptz,
  add column if not exists promoted_auto boolean     not null default false,
  add column if not exists notified_at   timestamptz,
  add column if not exists notify_error  text;

create or replace function public.promote_event_waitlist(
  p_event text,
  p_slot  text,
  p_actor text default 'auto'
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_capacity integer;
  v_taken    integer;
  v_left     integer;
  r          record;
  v_out      jsonb := '[]'::jsonb;
begin
  select capacity into v_capacity
    from public.event_slots where event_slug = p_event and slot_key = p_slot;
  if not found then
    return v_out;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('event:' || p_event || ':' || p_slot, 0));

  select coalesce(sum(party_size), 0) into v_taken
    from public.event_registrations
   where event_slug = p_event and slot_key = p_slot and status = 'confirmed';
  v_left := v_capacity - v_taken;

  for r in
    select id, name, party_size
      from public.event_registrations
     where event_slug = p_event and slot_key = p_slot and status = 'waitlisted' and not held
     order by created_at, id
  loop
    exit when v_left <= 0;
    if r.party_size <= v_left then
      update public.event_registrations
         set status            = 'confirmed',
             over_capacity     = false,
             promoted_at       = now(),
             promoted_auto     = true,
             notified_at       = null,
             notify_error      = null,
             status_changed_at = now(),
             changed_by        = p_actor
       where id = r.id;
      v_left := v_left - r.party_size;
      v_out := v_out || jsonb_build_array(jsonb_build_object('id', r.id, 'name', r.name, 'party_size', r.party_size));
    end if;
  end loop;

  return v_out;
end;
$$;

-- Raising a slot's capacity frees seats too.
create or replace function public.event_slots_capacity_promote()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.capacity > old.capacity then
    perform public.promote_event_waitlist(new.event_slug, new.slot_key, 'auto');
  end if;
  return new;
end;
$$;

drop trigger if exists event_slots_capacity_promote on public.event_slots;
create trigger event_slots_capacity_promote
  after update of capacity on public.event_slots
  for each row execute function public.event_slots_capacity_promote();

-- register_for_event: identical to 00231 except an entry an admin forces onto the waitlist is held.
create or replace function public.register_for_event(
  p_event        text,
  p_slot         text,
  p_name         text,
  p_email        text,
  p_phone        text,
  p_adult_names  jsonb,
  p_children     jsonb,
  p_source       text    default 'web',
  p_force_status text    default null,
  p_actor        text    default null,
  p_notes        text    default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_capacity  integer;
  v_taken     integer;
  v_adults    integer;
  v_children  integer;
  v_party     integer;
  v_status    text;
  v_over      boolean := false;
  v_id        uuid;
  v_existing  public.event_registrations;
  v_email     text := nullif(btrim(coalesce(p_email, '')), '');
begin
  if p_source not in ('web', 'admin') then raise exception 'invalid_source'; end if;
  if p_force_status is not null and (p_source <> 'admin' or p_force_status not in ('confirmed', 'waitlisted')) then
    raise exception 'invalid_status';
  end if;
  if p_source = 'web' and v_email is null then raise exception 'email_required'; end if;

  select capacity into v_capacity
    from public.event_slots
   where event_slug = p_event and slot_key = p_slot;
  if not found then
    raise exception 'unknown_slot';
  end if;

  v_adults   := coalesce(jsonb_array_length(p_adult_names), 0);
  v_children := coalesce(jsonb_array_length(p_children), 0);
  if v_adults < 1 or v_adults > 2 or v_children < 1 or v_children > 3 then
    raise exception 'invalid_party';
  end if;
  v_party := v_adults + v_children;

  perform pg_advisory_xact_lock(hashtextextended('event:' || p_event || ':' || p_slot, 0));

  if v_email is not null then
    select * into v_existing
      from public.event_registrations
     where event_slug = p_event and lower(email) = lower(v_email) and status <> 'cancelled';
    if found then
      return jsonb_build_object(
        'status', v_existing.status, 'id', v_existing.id, 'duplicate', true,
        'party_size', v_existing.party_size, 'slot_key', v_existing.slot_key);
    end if;
  end if;

  select coalesce(sum(party_size), 0) into v_taken
    from public.event_registrations
   where event_slug = p_event and slot_key = p_slot and status = 'confirmed';

  if p_force_status = 'confirmed' then
    v_status := 'confirmed';
    v_over   := v_taken + v_party > v_capacity;
  elsif p_force_status = 'waitlisted' then
    v_status := 'waitlisted';
  else
    v_status := case when v_taken + v_party <= v_capacity then 'confirmed' else 'waitlisted' end;
  end if;

  begin
    insert into public.event_registrations
      (event_slug, slot_key, name, email, phone, adults, children, status, source, over_capacity,
       adult_names, child_details, notes, terms_accepted_at, status_changed_at, changed_by, held)
    values
      (p_event, p_slot, p_name, v_email, p_phone, v_adults, v_children, v_status, p_source, v_over,
       p_adult_names, p_children, nullif(btrim(coalesce(p_notes, '')), ''),
       case when p_source = 'web' then now() end,
       case when p_source = 'admin' then now() end,
       case when p_source = 'admin' then p_actor end,
       coalesce(p_force_status = 'waitlisted', false))
    returning id into v_id;
  exception when unique_violation then
    select * into v_existing
      from public.event_registrations
     where event_slug = p_event and lower(email) = lower(v_email) and status <> 'cancelled';
    return jsonb_build_object(
      'status', v_existing.status, 'id', v_existing.id, 'duplicate', true,
      'party_size', v_existing.party_size, 'slot_key', v_existing.slot_key);
  end;

  return jsonb_build_object(
    'status', v_status, 'id', v_id, 'duplicate', false,
    'party_size', v_party, 'slot_key', p_slot, 'over_capacity', v_over,
    'seats_left', greatest(v_capacity - v_taken - case when v_status = 'confirmed' then v_party else 0 end, 0));
end;
$$;

-- set_event_registration_status: as 00231, plus hold-on-waitlist, promotion stamps, and the
-- automatic promotion of others when a confirmed party's seats are freed.
create or replace function public.set_event_registration_status(
  p_id       uuid,
  p_status   text,
  p_override boolean default false,
  p_actor    text    default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reg       public.event_registrations;
  v_prev      text;
  v_capacity  integer;
  v_taken     integer;
  v_over      boolean := false;
  v_promoted  jsonb := '[]'::jsonb;
begin
  if p_status not in ('confirmed', 'waitlisted', 'cancelled') then raise exception 'invalid_status'; end if;

  select * into v_reg from public.event_registrations where id = p_id;
  if not found then raise exception 'not_found'; end if;

  perform pg_advisory_xact_lock(hashtextextended('event:' || v_reg.event_slug || ':' || v_reg.slot_key, 0));
  select * into v_reg from public.event_registrations where id = p_id;
  v_prev := v_reg.status;

  if p_status = 'confirmed' and v_prev <> 'confirmed' then
    select capacity into v_capacity
      from public.event_slots where event_slug = v_reg.event_slug and slot_key = v_reg.slot_key;
    select coalesce(sum(party_size), 0) into v_taken
      from public.event_registrations
     where event_slug = v_reg.event_slug and slot_key = v_reg.slot_key and status = 'confirmed';
    if v_taken + v_reg.party_size > v_capacity then
      if not p_override then
        return jsonb_build_object(
          'ok', false, 'error', 'no_capacity',
          'party_size', v_reg.party_size, 'seats_left', greatest(v_capacity - v_taken, 0));
      end if;
      v_over := true;
    end if;
  end if;

  update public.event_registrations
     set status            = p_status,
         over_capacity     = case when p_status = 'confirmed' then (v_over or (v_prev = 'confirmed' and v_reg.over_capacity)) else false end,
         held              = (p_status = 'waitlisted'),   -- an admin's waitlist move is a hold
         promoted_at       = case when p_status = 'confirmed' and v_prev = 'waitlisted' then now() else promoted_at end,
         promoted_auto     = case when p_status = 'confirmed' and v_prev = 'waitlisted' then false else promoted_auto end,
         notified_at       = case when p_status = 'confirmed' and v_prev = 'waitlisted' then null else notified_at end,
         notify_error      = case when p_status = 'confirmed' and v_prev = 'waitlisted' then null else notify_error end,
         status_changed_at = now(),
         changed_by        = p_actor
   where id = p_id;

  -- Seats were freed: offer them to the waitlist, oldest first.
  if v_prev = 'confirmed' and p_status <> 'confirmed' then
    v_promoted := public.promote_event_waitlist(v_reg.event_slug, v_reg.slot_key, 'auto');
  end if;

  return jsonb_build_object('ok', true, 'id', p_id, 'status', p_status, 'over_capacity', v_over, 'promoted', v_promoted);
end;
$$;

-- Same lock-down as 00231 / 00229: nothing here is callable from the browser.
revoke all on function public.promote_event_waitlist(text, text, text) from public, anon, authenticated;
grant execute on function public.promote_event_waitlist(text, text, text) to service_role;
revoke all on function public.event_slots_capacity_promote() from public, anon, authenticated;
revoke all on function public.register_for_event(text, text, text, text, text, jsonb, jsonb, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.register_for_event(text, text, text, text, text, jsonb, jsonb, text, text, text, text)
  to service_role;
revoke all on function public.set_event_registration_status(uuid, text, boolean, text)
  from public, anon, authenticated;
grant execute on function public.set_event_registration_status(uuid, text, boolean, text)
  to service_role;
