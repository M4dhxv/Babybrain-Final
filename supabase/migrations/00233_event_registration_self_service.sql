-- 00233_event_registration_self_service.sql
--
-- Self-service for launch-event registrants (builds on 00231 / 00232):
--
--   * find_event_registration   look a registration up by the email / phone / name typed on the form
--   * update_event_registration a registrant edits their RSVP (slot, party, contact details) - a confirmed
--                               party keeps its place unless the new slot / size really fits
--   * cancel_event_registration a registrant cancels: the registration is marked cancelled (kept on record,
--                               revoked: it no longer holds seats or blocks the email) and the freed seats go
--                               to the waitlist (00232 promotion)
--   * event_issues              "Report issue" complaints and "email corrected" notes, shown to the admin
--                               inside the event
--
-- Like the rest of the event system these are service-role only (server routes); anon / authenticated
-- can call none of it. Ownership is proved in the server route (two of name / email / phone must match,
-- then a short-lived signed token), never trusted from the browser.

create table if not exists public.event_issues (
  id               uuid primary key default gen_random_uuid(),
  event_slug       text not null references public.events (slug) on delete cascade,
  registration_id  uuid references public.event_registrations (id) on delete set null,
  kind             text not null check (kind in ('report', 'email_corrected')),
  name             text,
  email            text,
  phone            text,
  note             text,
  status           text not null default 'open' check (status in ('open', 'resolved')),
  created_at       timestamptz not null default now(),
  resolved_at      timestamptz,
  resolved_by      text
);
create index if not exists event_issues_event_status_idx
  on public.event_issues (event_slug, status, created_at desc);
alter table public.event_issues enable row level security;
revoke all on public.event_issues from anon, authenticated;

-- The best live registration for what was typed, with which of the three fields matched.
create or replace function public.find_event_registration(
  p_event text,
  p_name  text,
  p_email text,
  p_phone text
) returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  r record;
begin
  select e.*,
         (e.email is not null and p_email is not null and lower(e.email) = lower(p_email)) as m_email,
         (p_phone is not null and e.phone = p_phone)                                         as m_phone,
         (p_name is not null and lower(btrim(e.name)) = lower(btrim(p_name)))                 as m_name
    into r
    from public.event_registrations e
   where e.event_slug = p_event
     and e.status <> 'cancelled'
     and ((e.email is not null and p_email is not null and lower(e.email) = lower(p_email))
          or (p_phone is not null and e.phone = p_phone))
   order by ((e.email is not null and p_email is not null and lower(e.email) = lower(p_email))::int
             + (p_phone is not null and e.phone = p_phone)::int
             + (p_name is not null and lower(btrim(e.name)) = lower(btrim(p_name)))::int) desc,
            e.created_at
   limit 1;

  if not found then
    return jsonb_build_object('found', false);
  end if;

  return jsonb_build_object(
    'found', true,
    'id', r.id,
    'match_email', r.m_email, 'match_phone', r.m_phone, 'match_name', r.m_name,
    'matched', r.m_email::int + r.m_phone::int + r.m_name::int,
    'status', r.status, 'slot_key', r.slot_key,
    'name', r.name, 'email', r.email, 'phone', r.phone,
    'adults', r.adults, 'children', r.children, 'party_size', r.party_size,
    'adult_names', r.adult_names, 'child_details', r.child_details);
end;
$$;

-- Edit an RSVP. A confirmed party keeps its seats unless the new slot / size fits (it never loses its
-- place to an edit); a waitlisted party stays waitlisted unless the new size now fits (promotion).
create or replace function public.update_event_registration(
  p_id          uuid,
  p_slot        text,
  p_name        text,
  p_email       text,
  p_phone       text,
  p_adult_names jsonb,
  p_children    jsonb,
  p_actor       text default 'registrant'
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reg       public.event_registrations;
  v_cap       integer;
  v_taken     integer;
  v_adults    integer;
  v_children  integer;
  v_party     integer;
  v_old_slot  text;
  v_email     text := nullif(btrim(coalesce(p_email, '')), '');
  v_promoted  jsonb := '[]'::jsonb;
  v_status    text;
begin
  select * into v_reg from public.event_registrations where id = p_id;
  if not found or v_reg.status = 'cancelled' then raise exception 'not_found'; end if;
  v_old_slot := v_reg.slot_key;

  select capacity into v_cap
    from public.event_slots where event_slug = v_reg.event_slug and slot_key = p_slot;
  if not found then raise exception 'unknown_slot'; end if;

  v_adults   := coalesce(jsonb_array_length(p_adult_names), 0);
  v_children := coalesce(jsonb_array_length(p_children), 0);
  if v_adults < 1 or v_adults > 2 or v_children < 1 or v_children > 3 then raise exception 'invalid_party'; end if;
  if v_email is null then raise exception 'email_required'; end if;
  v_party := v_adults + v_children;

  -- Always lock the slot keys in the same order so two edits can never wait on each other.
  perform pg_advisory_xact_lock(hashtextextended('event:' || v_reg.event_slug || ':' || least(v_old_slot, p_slot), 0));
  if p_slot <> v_old_slot then
    perform pg_advisory_xact_lock(hashtextextended('event:' || v_reg.event_slug || ':' || greatest(v_old_slot, p_slot), 0));
  end if;

  select * into v_reg from public.event_registrations where id = p_id;
  if not found or v_reg.status = 'cancelled' then raise exception 'not_found'; end if;

  if v_reg.status = 'confirmed' and not (p_slot = v_reg.slot_key and v_party <= v_reg.party_size) then
    select coalesce(sum(party_size), 0) into v_taken
      from public.event_registrations
     where event_slug = v_reg.event_slug and slot_key = p_slot and status = 'confirmed' and id <> p_id;
    if v_taken + v_party > v_cap then
      return jsonb_build_object('ok', false, 'error', 'no_capacity', 'seats_left', greatest(v_cap - v_taken, 0));
    end if;
  end if;

  begin
    update public.event_registrations
       set slot_key          = p_slot,
           name              = p_name,
           email             = v_email,
           phone             = p_phone,
           adults            = v_adults,
           children          = v_children,
           adult_names       = p_adult_names,
           child_details     = p_children,
           over_capacity     = (over_capacity and status = 'confirmed' and p_slot = v_reg.slot_key and v_party <= v_reg.party_size),
           status_changed_at = now(),
           changed_by        = p_actor
     where id = p_id;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'email_taken');
  end;

  -- Seats may have been released (smaller party, or a different slot): offer them to the waitlist.
  v_promoted := public.promote_event_waitlist(v_reg.event_slug, v_old_slot, 'auto');
  if p_slot <> v_old_slot then
    v_promoted := v_promoted || public.promote_event_waitlist(v_reg.event_slug, p_slot, 'auto');
  end if;

  select status into v_status from public.event_registrations where id = p_id;
  return jsonb_build_object('ok', true, 'status', v_status, 'promoted', v_promoted);
end;
$$;

-- Cancel: the registration is revoked. It stays in the table with status 'cancelled' (so the admin still
-- sees who cancelled and when), no longer holds seats, and its email can register again (the one-live-
-- registration-per-email index ignores cancelled rows). Freed seats go to the waitlist.
create or replace function public.cancel_event_registration(
  p_id    uuid,
  p_actor text default 'registrant'
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reg      public.event_registrations;
  v_promoted jsonb := '[]'::jsonb;
begin
  select * into v_reg from public.event_registrations where id = p_id;
  if not found or v_reg.status = 'cancelled' then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('event:' || v_reg.event_slug || ':' || v_reg.slot_key, 0));
  select * into v_reg from public.event_registrations where id = p_id;
  if not found or v_reg.status = 'cancelled' then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  update public.event_registrations
     set status            = 'cancelled',
         over_capacity     = false,
         held              = false,
         status_changed_at = now(),
         changed_by        = p_actor
   where id = p_id;

  if v_reg.status = 'confirmed' then
    v_promoted := public.promote_event_waitlist(v_reg.event_slug, v_reg.slot_key, 'auto');
  end if;

  return jsonb_build_object(
    'ok', true, 'status', v_reg.status, 'event_slug', v_reg.event_slug,
    'slot_key', v_reg.slot_key, 'party_size', v_reg.party_size, 'promoted', v_promoted);
end;
$$;

-- An admin re-confirming a cancelled registration whose email has since registered again would hit the
-- one-live-registration-per-email index: report it instead of failing. (Redefined from 00232 with that guard.)
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

  begin
    update public.event_registrations
       set status            = p_status,
           over_capacity     = case when p_status = 'confirmed' then (v_over or (v_prev = 'confirmed' and v_reg.over_capacity)) else false end,
           held              = (p_status = 'waitlisted'),
           promoted_at       = case when p_status = 'confirmed' and v_prev = 'waitlisted' then now() else promoted_at end,
           promoted_auto     = case when p_status = 'confirmed' and v_prev = 'waitlisted' then false else promoted_auto end,
           notified_at       = case when p_status = 'confirmed' and v_prev = 'waitlisted' then null else notified_at end,
           notify_error      = case when p_status = 'confirmed' and v_prev = 'waitlisted' then null else notify_error end,
           status_changed_at = now(),
           changed_by        = p_actor
     where id = p_id;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'email_taken');
  end;

  if v_prev = 'confirmed' and p_status <> 'confirmed' then
    v_promoted := public.promote_event_waitlist(v_reg.event_slug, v_reg.slot_key, 'auto');
  end if;

  return jsonb_build_object('ok', true, 'id', p_id, 'status', p_status, 'over_capacity', v_over, 'promoted', v_promoted);
end;
$$;

revoke all on function public.find_event_registration(text, text, text, text) from public, anon, authenticated;
grant execute on function public.find_event_registration(text, text, text, text) to service_role;
revoke all on function public.update_event_registration(uuid, text, text, text, text, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function public.update_event_registration(uuid, text, text, text, text, jsonb, jsonb, text) to service_role;
revoke all on function public.cancel_event_registration(uuid, text) from public, anon, authenticated;
grant execute on function public.cancel_event_registration(uuid, text) to service_role;
revoke all on function public.set_event_registration_status(uuid, text, boolean, text) from public, anon, authenticated;
grant execute on function public.set_event_registration_status(uuid, text, boolean, text) to service_role;
