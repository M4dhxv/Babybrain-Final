-- 00089_booking_gates.sql
--
-- Two booking-function fixes (QA 2026-09-02).
--
-- 1. H-1 (defence in depth): refuse a new booking when the owning provider is
--    not `active`. 00088 already removes a draft/suspended provider's listings
--    from discovery; this closes the residual path where someone holding a
--    session id posts a booking directly (native, package-credit or make-up
--    token — all of which run as the caller and hit this trigger). The trusted
--    service-role path (Stripe webhook, Wix finalisers) still returns early at
--    the top, unchanged.
--
-- 2. O-2: reschedule_booking accepted p_new_session_id equal to the booking's
--    current session — a no-op that "succeeded" and fired a spurious
--    "Booking moved" notification. Reject it.
--
-- !! HIGHER RISK than 00088: enforce_booking_insert_defaults is the core
-- booking-insert gate. Apply this to a scratch/staging database and run
-- `npm run validate:booking-rules` (26 checks) + `npm run validate:vendor`
-- against it BEFORE applying to production — the change cannot be exercised
-- until it is applied.

create or replace function public.enforce_booking_insert_defaults()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_price numeric;
  v_paused boolean;
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

  select coalesce(s.price, a.price), a.bookings_paused, a.provider_id,
         s.starts_at, a.booking_cutoff_minutes, a.info_request_enabled, pr.status
    into v_price, v_paused, v_provider,
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

  if coalesce(v_paused, false) and not v_is_manager then
    raise exception 'Bookings for this class are currently paused.';
  end if;

  if not v_is_manager
     and v_starts_at is not null
     and v_starts_at - make_interval(mins => coalesce(v_cutoff, 15)) <= now() then
    if coalesce(v_cutoff, 15) = 0 then
      raise exception 'This class has already started.';
    end if;
    raise exception 'Bookings for this class close % minutes before it starts.', coalesce(v_cutoff, 15);
  end if;

  -- 1.3 (00074): the vendor's booking question must be answered — except on a
  -- companion seat of a multi-child booking (00084), where it rode in on the
  -- primary seat.
  if coalesce(v_info_enabled, false) and not v_is_manager
     and coalesce(new.guest_name, '') = ''
     and coalesce(btrim(new.info_response), '') = '' then
    raise exception 'This class needs some extra information before you can book.';
  end if;

  new.amount := null;
  new.stripe_payment_intent := null;

  if v_is_manager and new.guest_name is not null then
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
      null;
    else
      new.waitlist_position := null;
      if coalesce(v_price, 0) = 0 then
        new.status := 'confirmed';
      else
        new.status := 'pending';
      end if;
    end if;
  end if;
  return new;
end;
$$;

-- ---------- O-2: reschedule_booking rejects a no-op same-session move ----------
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

  select s.id, s.activity_id, s.starts_at, s.capacity into v_new
  from public.activity_sessions s where s.id = p_new_session_id;
  if v_new.id is null or v_new.activity_id <> v_act_id then
    raise exception 'You can only reschedule to another session of the same class.';
  end if;
  if v_new.starts_at <= now() then
    raise exception 'That session has already started.';
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
    jsonb_build_object('url', '/profile?tab=bookings', 'booking_id', p_booking_id)
  );

  return v_bk.status;
end;
$function$;
