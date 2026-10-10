-- 00231_launch_event_registrations.sql
--
-- Registrations for the BabyBrain x The Artground launch event (babybrain.sg/events), and a
-- generic events/slots model so future events can be listed in the admin "Events" tab.
--
--   events               one row per event (title, date, venue)
--   event_slots          the time slots of an event, each with its own seat capacity
--   event_registrations  one row per registration (a "party": the registrant, an optional
--                        second adult and 1-3 children) - confirmed / waitlisted / cancelled
--
-- Capacity rule (per slot):
--   * a party takes `adults + children` seats;
--   * on the public page it is confirmed when the slot's confirmed seats + its party size
--     <= the slot capacity, otherwise the whole party goes to the waitlist and takes no seats;
--   * a waitlisted party never blocks a later, smaller party that still fits - the free seats
--     stay available to anyone whose whole party fits (that is simply how the rule above works).
--
-- Admin controls (server routes only):
--   * add a registration by hand (phone / walk-in enquiries) - auto-placed by capacity, or
--     forced to confirmed / waitlisted;
--   * promote a waitlisted party, or accept any registration, i.e. set it to confirmed - it
--     must fit the free seats unless the admin explicitly overrides capacity;
--   * move a party back to the waitlist, or cancel it (frees its seats).
--   Every change records who did it and when (changed_by / status_changed_at).
--
-- Everything is written through the two functions below, which take an advisory lock per
-- event slot so two registrations at the same moment cannot both take the last seats.
-- The tables and functions are NOT reachable by anon/authenticated (see 00229: Postgres
-- grants EXECUTE to PUBLIC on every new function unless it is revoked); only the server
-- routes, which hold the service-role key, call them.

create table if not exists public.events (
  slug        text primary key,
  title       text not null,
  starts_on   date,
  venue       text,
  created_at  timestamptz not null default now()
);

create table if not exists public.event_slots (
  event_slug  text not null references public.events (slug) on delete cascade,
  slot_key    text not null,
  label       text not null,
  capacity    integer not null check (capacity >= 0),
  sort        integer not null default 0,
  primary key (event_slug, slot_key)
);

create table if not exists public.event_registrations (
  id                 uuid primary key default gen_random_uuid(),
  event_slug         text not null,
  slot_key           text not null,
  name               text not null,
  email              text,                                   -- optional for entries an admin adds by hand
  phone              text not null,
  adults             integer not null check (adults between 1 and 2),
  children           integer not null check (children between 1 and 3),
  party_size         integer generated always as (adults + children) stored,
  status             text not null check (status in ('confirmed', 'waitlisted', 'cancelled')),
  source             text not null default 'web' check (source in ('web', 'admin')),
  over_capacity      boolean not null default false,         -- confirmed by an admin past the slot capacity
  adult_names        jsonb not null default '[]'::jsonb,     -- ["Registrant name", "Second adult"?]
  child_details      jsonb not null default '[]'::jsonb,     -- [{"name": "...", "age": "<1" | "1".."9"}]
  notes              text,
  terms_accepted_at  timestamptz,                            -- null for entries added by hand
  created_at         timestamptz not null default now(),
  status_changed_at  timestamptz,
  changed_by         text,                                   -- admin email for manual adds / status changes
  foreign key (event_slug, slot_key) references public.event_slots (event_slug, slot_key)
);

-- One live registration per email per event (a double click or a retry must not take seats
-- twice). A cancelled one doesn't count, so that person can register again.
create unique index if not exists event_registrations_one_per_email
  on public.event_registrations (event_slug, lower(email))
  where email is not null and status <> 'cancelled';
create index if not exists event_registrations_slot_status_idx
  on public.event_registrations (event_slug, slot_key, status);

alter table public.events              enable row level security;
alter table public.event_slots         enable row level security;
alter table public.event_registrations enable row level security;
revoke all on public.events, public.event_slots, public.event_registrations from anon, authenticated;

insert into public.events (slug, title, starts_on, venue) values
  ('launch-2026', 'BabyBrain Launch', date '2026-11-08', 'The Artground @ One Holland Village')
on conflict (slug) do nothing;

insert into public.event_slots (event_slug, slot_key, label, capacity, sort) values
  ('launch-2026', '1445-1545', '2:45 PM – 3:45 PM', 50, 1),
  ('launch-2026', '1600-1700', '4:00 PM – 5:00 PM', 50, 2)
on conflict (event_slug, slot_key) do nothing;

-- Register a party. p_source = 'web' for the public page; the admin route passes 'admin',
-- an optional forced status ('confirmed' | 'waitlisted'), the admin's email and notes.
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

  -- Serialise registrations for this slot so the capacity check and the insert are one step.
  perform pg_advisory_xact_lock(hashtextextended('event:' || p_event || ':' || p_slot, 0));

  -- Same email again (retry / double click / back-and-resubmit): report what they already have.
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
    -- Whole party fits -> confirmed. Otherwise the whole party is waitlisted (never split),
    -- and the seats that are left stay open for any smaller party.
    v_status := case when v_taken + v_party <= v_capacity then 'confirmed' else 'waitlisted' end;
  end if;

  begin
    insert into public.event_registrations
      (event_slug, slot_key, name, email, phone, adults, children, status, source, over_capacity,
       adult_names, child_details, notes, terms_accepted_at, status_changed_at, changed_by)
    values
      (p_event, p_slot, p_name, v_email, p_phone, v_adults, v_children, v_status, p_source, v_over,
       p_adult_names, p_children, nullif(btrim(coalesce(p_notes, '')), ''),
       case when p_source = 'web' then now() end,
       case when p_source = 'admin' then now() end,
       case when p_source = 'admin' then p_actor end)
    returning id into v_id;
  exception when unique_violation then
    -- the same email raced us through a different slot's lock: report that registration
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

-- Admin: move a registration to confirmed (promote from the waitlist / accept), back to the
-- waitlist, or cancel it. Confirming must fit the free seats unless p_override is true.
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
  v_capacity  integer;
  v_taken     integer;
  v_over      boolean := false;
begin
  if p_status not in ('confirmed', 'waitlisted', 'cancelled') then raise exception 'invalid_status'; end if;

  select * into v_reg from public.event_registrations where id = p_id;
  if not found then raise exception 'not_found'; end if;

  perform pg_advisory_xact_lock(hashtextextended('event:' || v_reg.event_slug || ':' || v_reg.slot_key, 0));
  -- re-read under the lock
  select * into v_reg from public.event_registrations where id = p_id;

  if p_status = 'confirmed' and v_reg.status <> 'confirmed' then
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
         over_capacity     = case when p_status = 'confirmed' then (v_over or (v_reg.status = 'confirmed' and v_reg.over_capacity)) else false end,
         status_changed_at = now(),
         changed_by        = p_actor
   where id = p_id;

  return jsonb_build_object('ok', true, 'id', p_id, 'status', p_status, 'over_capacity', v_over);
end;
$$;

revoke all on function public.register_for_event(text, text, text, text, text, jsonb, jsonb, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.register_for_event(text, text, text, text, text, jsonb, jsonb, text, text, text, text)
  to service_role;
revoke all on function public.set_event_registration_status(uuid, text, boolean, text)
  from public, anon, authenticated;
grant execute on function public.set_event_registration_status(uuid, text, boolean, text)
  to service_role;
