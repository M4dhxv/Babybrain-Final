-- 00084_session_pause_and_manual_bookings.sql
--
-- QA 04/09/26, two vendor rows:
--
-- 1. "Vendors need to be able to pause bookings on a particular class etc.
--    Currently can only do at activity level which would pause bookings on all
--    scheduled classes for that activity."
--
--    `activities.bookings_paused` (00026) is all-or-nothing: pausing one week's
--    session because the teacher is away also closed every other session of
--    that class. Pause moves to the session as well, and the gate honours
--    either — the activity switch still stops the lot, a session switch stops
--    just that slot.
--
-- 2. "When a booking is added manually, can't edit or delete."
--
--    Editing already worked at the database level (the "managers update
--    bookings" policy covers it) — it was only missing from the UI. Deleting
--    did not: there is no DELETE policy on `bookings` at all, so the vendor
--    SPA's delete would have silently removed nothing.
--
--    A DELETE policy is added, deliberately narrow: manual rows only
--    (`user_id is null and guest_name is not null`), on the vendor's own
--    provider, and only for a manager. A manual booking is the vendor's own
--    record of something that happened offline, so a mistyped one should
--    disappear rather than linger as a cancelled row on the roster. A real
--    parent's booking is never deletable — it belongs to them, carries payment
--    and policy-acceptance history, and the correct action there is a
--    cancellation, which notifies them and returns their credit or token.

begin;

-- =============================================================
-- 1. Pause bookings on a single session
-- =============================================================
alter table public.activity_sessions
  add column if not exists bookings_paused boolean not null default false;

comment on column public.activity_sessions.bookings_paused is
  'Stops parents booking this one session. Independent of '
  'activities.bookings_paused, which stops every session of the activity.';

-- The booking gate, unchanged from 00082 except that it now reads the
-- session's own pause flag alongside the activity's, and says which one
-- stopped the booking.
create or replace function public.enforce_booking_insert_defaults()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_price numeric;
  v_paused boolean;
  v_session_paused boolean;
  v_provider uuid;
  v_provider_status text;
  v_is_manager boolean := false;
  v_starts_at timestamptz;
  v_cutoff int;
  v_info_enabled boolean;
begin
  if coalesce(auth.role(), '') = 'service_role' then
    return new;  -- trusted server path (Stripe webhook) sets its own state
  end if;

  select coalesce(s.price, a.price), a.bookings_paused, s.bookings_paused, a.provider_id,
         s.starts_at, a.booking_cutoff_minutes, a.info_request_enabled, pr.status
    into v_price, v_paused, v_session_paused, v_provider,
         v_starts_at, v_cutoff, v_info_enabled, v_provider_status
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  left join public.providers pr on pr.id = a.provider_id
  where s.id = new.session_id;

  v_is_manager := v_provider in (select public.user_manage_provider_ids());

  -- H-1: a draft/suspended/pending provider is not taking bookings. Checked
  -- here so it covers the native, package-credit and make-up-token paths at
  -- once (all run as the caller, not the service role). A provider-less
  -- activity (v_provider_status null) is treated as available, unchanged.
  if coalesce(v_provider_status, 'active') <> 'active' then
    raise exception 'This provider is not currently taking bookings.';
  end if;

  -- 1.1: parents cannot book a paused class; vendors can still record manual
  -- bookings against it. 00084: the pause is now per-session as well as
  -- per-activity, and the message says which.
  if not v_is_manager then
    if coalesce(v_paused, false) then
      raise exception 'Bookings for this class are currently paused.';
    end if;
    if coalesce(v_session_paused, false) then
      raise exception 'Bookings for this session are currently paused — other dates may still be available.';
    end if;
  end if;

  -- 1.2 (00074): the booking cut-off. Vendors are exempt so they can still
  -- record a walk-in at the door, which is exactly when they need to.
  if not v_is_manager
     and v_starts_at is not null
     and v_starts_at - make_interval(mins => coalesce(v_cutoff, 15)) <= now() then
    if coalesce(v_cutoff, 15) = 0 then
      raise exception 'This class has already started.';
    end if;
    raise exception 'Bookings for this class close % minutes before it starts.', coalesce(v_cutoff, 15);
  end if;

  -- 1.3 (00074): if the vendor asks for information at booking, it has to be
  -- answered. Enforced here, not just in the UI, for the same reason the
  -- waiver gate is: the client can be bypassed.
  if coalesce(v_info_enabled, false) and not v_is_manager
     and coalesce(btrim(new.info_response), '') = '' then
    raise exception 'This class needs some extra information before you can book.';
  end if;

  -- Nobody but the server sets Stripe payment state.
  new.amount := null;
  new.stripe_payment_intent := null;

  if v_is_manager and new.guest_name is not null then
    -- 2.1: manual vendor booking — recorded as confirmed (waitlisted if the
    -- capacity trigger put it there); vendors may mark it paid (offline
    -- payment) but never refunded.
    if new.payment_status is null or new.payment_status not in ('none', 'paid') then
      new.payment_status := 'none';
    end if;
    if new.status is distinct from 'waitlisted' then
      new.status := 'confirmed';
      new.waitlist_position := null;
    end if;
  else
    new.payment_status := 'none';
    if new.status = 'waitlisted' then
      null; -- preserve status + position set by handle_booking_insert
    else
      new.waitlist_position := null;
      if coalesce(v_price, 0) = 0 then
        new.status := 'confirmed';   -- free class: nothing to pay
      else
        new.status := 'pending';     -- paid class: Stripe webhook confirms
      end if;
    end if;
  end if;

  return new;
end;
$function$;

-- =============================================================
-- 2. Let a manager delete a manual booking (and only a manual one)
-- =============================================================
drop policy if exists "managers delete manual bookings" on public.bookings;
create policy "managers delete manual bookings" on public.bookings
  for delete
  using (
    user_id is null
    and guest_name is not null
    and provider_id in (select public.user_manage_provider_ids())
  );


-- =============================================================
-- 3. Rescheduling must respect a pause too
--    reschedule_booking never checked bookings_paused — not even the
--    activity-level flag from 00026 — so a parent could move a booking onto a
--    session the vendor had closed. A pause that reschedule walks straight
--    through is not a pause. Otherwise identical to the 00082 version; the
--    "Booking moved" notification also now carries the new session's date,
--    venue and duration, which it never has (the template reads them, so the
--    email has always gone out without the detail block).
-- =============================================================
create or replace function public.reschedule_booking(p_booking_id uuid, p_new_session_id uuid)
 returns text
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_user uuid := auth.uid();
  v_bk public.bookings;
  v_act_id uuid;
  v_act_title text;
  v_allow boolean;
  v_cutoff integer;
  v_old_starts timestamptz;
  v_new record;
  v_taken int;
begin
  if v_user is null then raise exception 'Not authenticated'; end if;

  select b.* into v_bk from public.bookings b
  where b.id = p_booking_id and b.user_id = v_user;
  if not found then raise exception 'Booking not found'; end if;
  if v_bk.status not in ('pending', 'confirmed') then
    raise exception 'Only upcoming bookings can be rescheduled.';
  end if;

  -- O-2: moving to the session it's already on is a no-op that used to
  -- "succeed" and fire a bogus "Booking moved" notification.
  if p_new_session_id = v_bk.session_id then
    raise exception 'That booking is already on this session — pick a different one.';
  end if;

  select a.id, a.title, a.allow_rescheduling, a.reschedule_cutoff_hours, s.starts_at
    into v_act_id, v_act_title, v_allow, v_cutoff, v_old_starts
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  where s.id = v_bk.session_id;

  if not v_allow then
    raise exception 'The provider does not allow rescheduling for this class.';
  end if;
  if v_old_starts - make_interval(hours => v_cutoff) < now() then
    raise exception 'The rescheduling window for this class has closed (% hours before the session).', v_cutoff;
  end if;

  select s.id, s.activity_id, s.starts_at, s.capacity, s.bookings_paused, a.bookings_paused as activity_paused
    into v_new
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  where s.id = p_new_session_id;
  if v_new.id is null or v_new.activity_id <> v_act_id then
    raise exception 'You can only reschedule to another session of the same class.';
  end if;
  if v_new.starts_at <= now() then
    raise exception 'That session has already started.';
  end if;
  if coalesce(v_new.activity_paused, false) then
    raise exception 'Bookings for this class are currently paused.';
  end if;
  if coalesce(v_new.bookings_paused, false) then
    raise exception 'Bookings for that session are currently paused — please pick another date.';
  end if;
  if v_new.capacity is not null then
    select count(*) into v_taken from public.bookings
    where session_id = p_new_session_id and status in ('pending', 'confirmed');
    if v_taken >= v_new.capacity then
      raise exception 'That session is full.';
    end if;
  end if;

  update public.bookings set session_id = p_new_session_id where id = p_booking_id;

  insert into public.notifications (user_id, type, title, body, data)
  values (
    v_user,
    'booking_rescheduled',
    'Booking moved',
    'Your booking for ' || coalesce(v_act_title, 'a class') || ' is now on ' ||
      to_char(v_new.starts_at at time zone 'Asia/Singapore', 'Dy DD Mon') || ' at ' ||
      to_char(v_new.starts_at at time zone 'Asia/Singapore', 'HH12:MIam') || '.',
    public.session_email_details(p_new_session_id) || jsonb_build_object(
      'url', '/profile?tab=bookings',
      'booking_id', p_booking_id)
  );

  return v_bk.status;
end;
$function$;


commit;
