-- 00249_vendor_reschedule_and_pack_booking.sql
--
-- Two vendor actions on the Bookings page (client, 2026-10-21):
--
--   vendor_reschedule_booking  — move a family to another session of the same class, the way
--     a vendor can already cancel them. The whole party (every live seat of a multi-child
--     booking) moves together, like the parent's own reschedule. The parent's own limits
--     (reschedule window, "rescheduling not allowed") don't apply — it's the vendor's call —
--     but the target must be a future session of the same class with room, unless the vendor
--     chose to raise its capacity to fit. The parent is told by email and push with the same
--     "What changed" email as a vendor changing a session's time or venue (session_rescheduled).
--
--   vendor_book_with_package   — book a parent who bought one of this vendor's packs onto a
--     class, spending their credits: the same rules and bookkeeping as the parent's own
--     redeem_package_credit (00197: only seats actually booked use a credit; a seat that lands
--     on the waitlist is free). The parent gets the usual booking confirmation.
--
-- Both are called only by the vendor API routes (app/api/vendor/bookings/{reschedule,pack}),
-- which check the caller is a manager/owner of the business first; the functions re-check the
-- booking/pack belongs to that business. service_role only — never callable over RPC by a
-- browser. Running as service_role is also what lets a vendor book on a parent's behalf past
-- the parent-facing waiver/information gates (00044/00193), exactly as the vendor's manual
-- "Add booking" already does.
--
-- Idempotent.

begin;

create or replace function public.vendor_reschedule_booking(
  p_provider uuid,
  p_booking_id uuid,
  p_new_session_id uuid,
  p_increase_capacity boolean default false
)
returns table (moved integer, new_starts_at timestamptz, capacity_raised integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bk public.bookings;
  v_old record;
  v_new record;
  v_ids uuid[];
  v_party int;
  v_taken int;
  v_raise int := 0;
  v_business text;
  v_old_venue text;
  v_new_venue text;
  v_changes jsonb;
begin
  select * into v_bk from public.bookings where id = p_booking_id;
  if not found then raise exception 'That booking no longer exists.'; end if;
  if v_bk.status not in ('pending', 'confirmed') then
    raise exception 'Only upcoming bookings can be moved.';
  end if;
  if p_new_session_id = v_bk.session_id then
    raise exception 'That booking is already on this session — pick a different one.';
  end if;

  select s.id, s.activity_id, s.starts_at, s.location_id, a.provider_id, a.title, a.wix_service_type
    into v_old
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  where s.id = v_bk.session_id;
  if v_old.provider_id is distinct from p_provider then
    raise exception 'That booking is not with your business.';
  end if;
  if v_old.wix_service_type in ('EVENT', 'COURSE') then
    raise exception 'Wix events and courses can''t be moved to another session.';
  end if;

  -- Lock the target for the capacity count and the move (same reason as 00160).
  select s.id, s.activity_id, s.starts_at, s.location_id, s.capacity, coalesce(s.status, 'scheduled') as status
    into v_new
  from public.activity_sessions s
  where s.id = p_new_session_id
  for update of s;
  if v_new.id is null or v_new.activity_id <> v_old.activity_id then
    raise exception 'You can only move a booking to another session of the same class.';
  end if;
  if v_new.status = 'cancelled' then
    raise exception 'That session has been cancelled.';
  end if;
  if v_new.starts_at <= now() then
    raise exception 'That session has already started.';
  end if;

  -- The whole party moves together (00084).
  if v_bk.booking_group_id is not null then
    select array_agg(id) into v_ids from public.bookings
     where booking_group_id = v_bk.booking_group_id and status in ('pending', 'confirmed');
  else
    v_ids := array[v_bk.id];
  end if;
  v_party := coalesce(array_length(v_ids, 1), 1);

  if v_new.capacity is not null then
    select count(*) into v_taken from public.bookings
     where session_id = p_new_session_id and status in ('pending', 'confirmed');
    if v_taken + v_party > v_new.capacity then
      if not p_increase_capacity then
        raise exception 'That session is full (% of % places taken). Raise its capacity to move % there.',
          v_taken, v_new.capacity, case when v_party = 1 then 'this booking' else 'this party' end;
      end if;
      v_raise := v_taken + v_party - v_new.capacity;
      update public.activity_sessions set capacity = capacity + v_raise where id = p_new_session_id;
    end if;
  end if;

  update public.bookings set session_id = p_new_session_id where id = any(v_ids);

  -- Tell the parent by email and push (a manual entry has no parent account to tell). It's a
  -- 'session_rescheduled' notification — the same "What changed" email a parent gets when a vendor
  -- changes a booked session's time or venue (00209), built with the same helpers, so a move reads
  -- exactly like a change: Time old → new, and Venue old → new when the venue differs too.
  if v_bk.user_id is not null then
    select business_name into v_business from public.providers where id = p_provider;
    v_old_venue := public.change_venue(v_old.location_id, v_old.activity_id);
    v_new_venue := public.change_venue(v_new.location_id, v_new.activity_id);
    v_changes := jsonb_build_array(jsonb_build_object(
      'label', 'Time', 'old', public.change_when(v_old.starts_at), 'new', public.change_when(v_new.starts_at)));
    if v_new_venue is distinct from v_old_venue then
      v_changes := v_changes || jsonb_build_array(jsonb_build_object('label', 'Venue', 'old', v_old_venue, 'new', v_new_venue));
    end if;
    insert into public.notifications (user_id, type, title, body, data)
    values (
      v_bk.user_id,
      'session_rescheduled',
      'Booking moved',
      coalesce(v_business, 'Your provider') || ' has moved your booking for ' || coalesce(v_old.title, 'a class') || ' to ' ||
        to_char(v_new.starts_at at time zone 'Asia/Singapore', 'Dy DD Mon') || ' at ' ||
        to_char(v_new.starts_at at time zone 'Asia/Singapore', 'HH12:MIam') || '.',
      jsonb_build_object(
        'url', '/profile?tab=bookings',
        'booking_id', v_bk.id,
        'activity_name', v_old.title,
        'provider_name', v_business,
        'moved_by_provider', true,
        'changes', v_changes,
        'date_time', public.change_when(v_new.starts_at),
        'address', v_new_venue)
    );
  end if;

  return query select v_party, v_new.starts_at, v_raise;
end;
$$;

create or replace function public.vendor_book_with_package(
  p_provider uuid,
  p_purchase_id uuid,
  p_session_id uuid,
  p_child_id uuid default null,
  p_quantity integer default 1,
  p_guest_names text[] default '{}'::text[]
)
returns table (status text, waitlisted_count integer, credits_left integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pur public.package_purchases;
  v_pkg public.packages;
  v_session record;
  v_booking_id uuid;
  v_this_status text;
  v_any_confirmed boolean := false;
  v_waitlisted_count int := 0;
  v_waitlisted_ids uuid[] := '{}';
  v_child uuid;
  v_group uuid := case when p_quantity > 1 then gen_random_uuid() else null end;
  v_i int;
begin
  if p_quantity < 1 or p_quantity > 6 then
    raise exception 'Book between 1 and 6 places.';
  end if;

  -- Locked, as in redeem_package_credit: two bookings can't both spend the last credit.
  select * into v_pur from public.package_purchases pp
   where pp.id = p_purchase_id and pp.provider_id = p_provider
   for update;
  if not found then raise exception 'That pack isn''t one of your business''s.'; end if;
  if v_pur.status <> 'active' or (v_pur.expires_at is not null and v_pur.expires_at <= now()) then
    raise exception 'That pack is no longer active (used up or expired).';
  end if;
  if v_pur.credits_remaining < p_quantity then
    raise exception 'That pack only has % credit% left.', v_pur.credits_remaining,
      case when v_pur.credits_remaining = 1 then '' else 's' end;
  end if;

  select * into v_pkg from public.packages where id = v_pur.package_id;

  select s.id, s.starts_at, s.activity_id, a.provider_id, a.wix_service_type, coalesce(s.status, 'scheduled') as status
    into v_session
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  where s.id = p_session_id;
  if not found or v_session.provider_id is distinct from p_provider then
    raise exception 'That session isn''t one of your classes.';
  end if;
  if v_session.status = 'cancelled' then raise exception 'That session has been cancelled.'; end if;
  if v_session.starts_at <= now() then raise exception 'That session has already started.'; end if;
  if v_session.wix_service_type in ('EVENT', 'COURSE', 'APPOINTMENT') then
    raise exception 'Pack credits can only be used on classes.';
  end if;
  -- The pack's own limits, exactly as the parent's own redemption applies them.
  if v_pkg.activity_ids is not null and array_length(v_pkg.activity_ids, 1) > 0
     and not (v_session.activity_id = any(v_pkg.activity_ids)) then
    raise exception 'That pack can''t be used for this class.';
  end if;
  if v_pkg.allowed_weekday is not null
     and extract(dow from v_session.starts_at at time zone 'Asia/Singapore') <> v_pkg.allowed_weekday then
    raise exception 'That pack can only be used on its set day of the week.';
  end if;
  if v_pkg.allowed_start_time is not null
     and (v_session.starts_at at time zone 'Asia/Singapore')::time <> v_pkg.allowed_start_time then
    raise exception 'That pack can only be used at its set start time.';
  end if;

  select c.id into v_child from public.children c
   where c.parent_id = v_pur.user_id and (p_child_id is null or c.id = p_child_id)
   order by c.created_at limit 1;
  if p_child_id is not null and v_child is null then
    raise exception 'That child isn''t on this parent''s profile.';
  end if;

  for v_i in 1..p_quantity loop
    insert into public.bookings (user_id, session_id, child_id, guest_name, package_purchase_id, booking_group_id)
    values (
      v_pur.user_id,
      p_session_id,
      case when v_i = 1 then v_child else null end,
      case when v_i = 1 then null else coalesce(nullif(btrim(p_guest_names[v_i - 1]), ''), 'Guest child') end,
      p_purchase_id,
      v_group
    )
    returning bookings.id, bookings.status into v_booking_id, v_this_status;

    if v_this_status = 'pending' then
      update public.bookings set status = 'confirmed' where id = v_booking_id;
      v_this_status := 'confirmed';
    end if;
    if v_this_status = 'waitlisted' then
      v_waitlisted_count := v_waitlisted_count + 1;
      v_waitlisted_ids := v_waitlisted_ids || v_booking_id;
    else
      v_any_confirmed := true;
    end if;
  end loop;

  -- 00197: only seats actually booked use a credit; a waitlisted seat is free.
  update public.package_purchases
     set credits_remaining = credits_remaining - (p_quantity - v_waitlisted_count),
         status = case when credits_remaining - (p_quantity - v_waitlisted_count) <= 0 then 'used' else package_purchases.status end
   where id = p_purchase_id;
  update public.bookings set package_purchase_id = null where id = any(v_waitlisted_ids);

  return query
    select (case when v_any_confirmed then 'confirmed' else 'waitlisted' end), v_waitlisted_count,
           (select credits_remaining from public.package_purchases where id = p_purchase_id);
end;
$$;

revoke all on function public.vendor_reschedule_booking(uuid, uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.vendor_reschedule_booking(uuid, uuid, uuid, boolean) to service_role;
revoke all on function public.vendor_book_with_package(uuid, uuid, uuid, uuid, integer, text[]) from public, anon, authenticated;
grant execute on function public.vendor_book_with_package(uuid, uuid, uuid, uuid, integer, text[]) to service_role;

notify pgrst, 'reload schema';

commit;
