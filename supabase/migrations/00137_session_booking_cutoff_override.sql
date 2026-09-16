-- 00137_session_booking_cutoff_override.sql
--
-- 00133 added per-session overrides for the cancellation/reschedule half of
-- "Booking policies" but missed the third field on that same card:
-- activities.booking_cutoff_minutes (how close to a session's start a
-- parent may still book it, migration 00074). Adds the matching per-session
-- override, same "null = inherit the activity default" rule as 00133.
--
-- Two enforcement points read this, both redefined here to coalesce the
-- session's own value over the activity's:
--   * enforce_booking_insert_defaults() (00074/00084/00089/00091) — the
--     BEFORE INSERT trigger on `bookings` for every native booking path
--     (book_party, redeem_package_credit, a plain insert).
--   * lib/wix/sync.ts's cutoffRejection(), fed by each Wix booking route
--     (checkout/bookings/redeem-package/redeem-token) — see the new
--     getWixSessionBookingCutoff() helper there, mirroring isWixSessionPaused.

begin;

alter table public.activity_sessions
  add column if not exists booking_cutoff_minutes integer
    check (booking_cutoff_minutes is null or (booking_cutoff_minutes >= 0 and booking_cutoff_minutes <= 20160));

comment on column public.activity_sessions.booking_cutoff_minutes is
  'Per-session override of activities.booking_cutoff_minutes. Null = inherit the activity default.';

-- =============================================================
-- enforce_booking_insert_defaults — coalesce session over activity
-- =============================================================
create or replace function public.enforce_booking_insert_defaults()
returns trigger
language plpgsql
security definer set search_path = public
as $$
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
         s.starts_at, coalesce(s.booking_cutoff_minutes, a.booking_cutoff_minutes),
         a.info_request_enabled, pr.status
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
  -- bookings against it. The pause is per-session as well as per-activity, and
  -- the message says which.
  if not v_is_manager then
    if coalesce(v_paused, false) then
      raise exception 'Bookings for this class are currently paused.';
    end if;
    if coalesce(v_session_paused, false) then
      raise exception 'Bookings for this session are currently paused — other dates may still be available.';
    end if;
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

notify pgrst, 'reload schema';

commit;
