-- 00090_waitlist_and_booking_email_links.sql
--
-- QA 04/09/26. Five reported rows, one root-cause cluster: the notification
-- producers that feed the parent emails.
--
-- 1. "Cancelled a booking where there was a waitlist and the parent on the
--    waitlist was automatically added to the booking but hadn't paid."
--
--    handle_booking_cancel() promoted the next waitlisted row straight to
--    `confirmed` with no regard for payment. A parent joining the waitlist on
--    a PAID class inserts at status `waitlisted` with payment_status `none`
--    (enforce_booking_insert_defaults, 00024) — they never reach Stripe,
--    because there is no seat to check out for. So every cancellation on a
--    paid class handed the next person in the queue a free confirmed seat.
--
--    Promotion is now pay-aware. A waitlisted row is only auto-confirmed when
--    it is already settled: Stripe took the money, a package credit paid for
--    it, a make-up token was redeemed against it, or the class is free and
--    there was nothing to pay. Otherwise the seat stays open and the parent is
--    told to go and book it — which is what the "waitlist_available" email has
--    always said, and now finally what actually happens.
--
-- 2. "Increased capacity on an activity but ... those on the waitlist were not
--    notified there is now a spot."
--
--    Nothing watched capacity. Raising it opened seats silently. A new trigger
--    on activity_sessions notifies as many waitlisted parents as there are new
--    seats, top of the queue first, using the same email as (1).
--
-- 3. "'A spot has become available' e-mail has a book now link which doesn't
--    take you to the page for the activity (it takes you to sign in then lands
--    on profile)."
--
--    Every booking notification carried `url = '/dashboard/bookings'` and the
--    follow-up carried `'/activities/<slug>'`. Neither route exists: since the
--    `beforeFiles` rewrite in next.config.mjs, the parent Vite SPA answers
--    every user-facing path, and its routes are `/profile?tab=bookings`,
--    `/activity?slug=…` and `/book?slug=…`. An unmatched path falls through to
--    the SPA's signed-in home — exactly the "lands on profile" that was
--    reported. All producers now emit real SPA URLs, and the spot-available
--    link deep-links to the booking page with the freed session preselected.
--
-- 4. "Post activity check-in e-mail says 'we hope you enjoyed your activity'"
--    and "links for leaving a review and re-booking take to your home profile
--    and the explore activities page."
--
--    send_class_followups() wrote only {url, activity_id}. The template reads
--    `activity_name`, `url` and `rebook_url`, so the name fell back to the
--    literal "your activity" and both links fell back to /explore. It now
--    writes all three.
--
-- 5. "Your booking is confirmed ... doesn't pull right location through — e.g.
--    Beach wanderers location is in a newly added location 'Palawan' but the
--    e-mail says it is in the Demo Studio."
--
--    Address resolved as `coalesce(l.address, a.address)` and joined the
--    location only via `s.location_id`. Two ways to get the stale activity
--    address: a venue added with a name but no street address (the address
--    field is optional in LocationsManager) made `l.address` null, and a venue
--    set on the ACTIVITY rather than the session was never joined at all.
--    Resolution is now session venue → activity venue → activity free-text
--    address, and a venue contributes its name as well as its address — the
--    same "Name, Address" shape the booking page shows the parent.
--
-- All of these are `create or replace` on existing functions plus one new
-- trigger; no schema change, no data change.

begin;

-- =============================================================
-- Shared: how a session's details render in an email.
-- Every producer below needs the same activity name / date / duration /
-- address / provider block, and the address rule in particular was being
-- restated (and getting out of step) in each one. One function, one rule.
-- =============================================================
create or replace function public.session_email_details(p_session uuid)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'activity_name', a.title,
    'date_time', to_char(
      s.starts_at at time zone 'Asia/Singapore',
      'Dy DD Mon YYYY, HH12:MI AM'),
    'duration', case
      when s.ends_at is not null then
        (extract(epoch from (s.ends_at - s.starts_at)) / 60)::int || ' minutes'
      else null end,
    -- Session venue overrides activity venue (00074); a venue with no street
    -- address still names itself rather than falling through to the activity's
    -- stale free-text address.
    'address', coalesce(
      nullif(concat_ws(', ', l.name, nullif(btrim(l.address), '')), ''),
      a.address),
    'type', p.business_name
  ))
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  left join public.providers p on p.id = a.provider_id
  left join public.provider_locations l on l.id = coalesce(s.location_id, a.location_id)
  where s.id = p_session;
$$;

comment on function public.session_email_details(uuid) is
  'Activity name / date-time / duration / address / provider for one session, '
  'shaped for the `details()` block in lib/emails/render.ts.';

-- =============================================================
-- Shared: notify one waitlisted parent that a seat is free to book.
-- Used by both the cancellation path and the capacity-increase path.
-- =============================================================
create or replace function public.notify_waitlist_spot_open(p_booking uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_bk public.bookings;
  v_slug text;
begin
  select * into v_bk from public.bookings where id = p_booking;
  if not found or v_bk.user_id is null then return; end if;

  select a.slug into v_slug
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  where s.id = v_bk.session_id;

  insert into public.notifications (user_id, type, title, body, data)
  values (
    v_bk.user_id,
    'waitlist_available',
    'A spot has opened up!',
    'A place has come free on a class you joined the waitlist for — book it before someone else does.',
    public.session_email_details(v_bk.session_id) || jsonb_strip_nulls(jsonb_build_object(
      -- Deep-link straight into the booking page with the freed slot already
      -- picked, so "Book now" is one click from the email.
      'url', case when v_slug is not null
                  then '/book?slug=' || v_slug || '&session=' || v_bk.session_id
                  else '/explore' end,
      'booking_id', v_bk.id,
      'session_id', v_bk.session_id
    ))
  );
end;
$$;

-- =============================================================
-- 1. Cancellation → pay-aware waitlist promotion
-- =============================================================
create or replace function public.handle_booking_cancel()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_next public.bookings;
  v_settled boolean;
begin
  if not (new.status = 'cancelled' and old.status in ('pending', 'confirmed')) then
    return new;
  end if;

  select * into v_next
  from public.bookings
  where session_id = new.session_id and status = 'waitlisted'
  order by waitlist_position nulls last, created_at
  limit 1;
  if not found then
    return new;
  end if;

  -- Has this waitlisted booking already been paid for, one way or another?
  v_settled :=
       v_next.payment_status = 'paid'
    or v_next.package_purchase_id is not null
    or exists (
         select 1 from public.make_up_tokens t
         where t.redeemed_booking_id = v_next.id and t.status = 'redeemed')
    or coalesce(public.session_price(new.session_id), 0) = 0;

  if v_settled then
    -- Already paid for (or free): the seat is theirs, take them off the queue.
    update public.bookings
    set status = 'confirmed', waitlist_position = null
    where id = v_next.id;

    insert into public.notifications (user_id, type, title, body, data)
    select v_next.user_id, 'waitlist_promoted', 'You''re off the waitlist! 🎉',
           'A spot opened up and your place is now confirmed.',
           public.session_email_details(new.session_id) || jsonb_build_object(
             'url', '/profile?tab=bookings',
             'booking_id', v_next.id)
    where v_next.user_id is not null;
  else
    -- Not paid for. Leave the seat open and invite them to book it — anything
    -- else hands out a paid class for free.
    perform public.notify_waitlist_spot_open(v_next.id);
  end if;

  return new;
end;
$$;

-- =============================================================
-- 2. Capacity raised → tell the front of the queue
-- =============================================================
create or replace function public.notify_waitlist_on_capacity_increase()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_taken int;
  v_free int;
  r record;
begin
  -- Only ever fires on a genuine increase. Uncapped (null) capacity means
  -- nobody should be waitlisted at all, so treat it as "plenty of room".
  if new.capacity is not distinct from old.capacity then
    return new;
  end if;
  if new.capacity is not null and old.capacity is not null and new.capacity <= old.capacity then
    return new;
  end if;

  select count(*) into v_taken
  from public.bookings
  where session_id = new.id and status in ('pending', 'confirmed');

  v_free := case when new.capacity is null then 2147483647 else new.capacity - v_taken end;
  if v_free <= 0 then
    return new;
  end if;

  -- One invitation per newly freed seat, in queue order. Nobody is promoted
  -- automatically — for a paid class they still have to check out, and this is
  -- a race the parents settle between themselves, first to book wins.
  for r in
    select id from public.bookings
    where session_id = new.id and status = 'waitlisted'
    order by waitlist_position nulls last, created_at
    limit v_free
  loop
    perform public.notify_waitlist_spot_open(r.id);
  end loop;

  return new;
end;
$$;

drop trigger if exists on_session_capacity_increase on public.activity_sessions;
create trigger on_session_capacity_increase
  after update of capacity on public.activity_sessions
  for each row execute function public.notify_waitlist_on_capacity_increase();

-- =============================================================
-- 3. Vendor manually promotes a specific waitlist entry
--    Left as an explicit confirm — a vendor choosing to seat someone is a
--    deliberate act, the same as recording a manual booking — but it now
--    sends the "you're confirmed" email rather than "go and book", and links
--    somewhere that exists.
-- =============================================================
create or replace function public.promote_waitlist_entry(p_booking_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_provider uuid;
  v_session uuid;
begin
  select provider_id, session_id into v_provider, v_session
  from public.bookings where id = p_booking_id;
  if v_provider is null or v_provider not in (select public.user_manage_provider_ids()) then
    raise exception 'not authorized';
  end if;

  update public.bookings set status = 'confirmed', waitlist_position = null
  where id = p_booking_id and status = 'waitlisted';

  insert into public.notifications (user_id, type, title, body, data)
  select user_id, 'waitlist_promoted', 'You''re off the waitlist! 🎉',
         'A spot opened up and your place is now confirmed.',
         public.session_email_details(v_session) || jsonb_build_object(
           'url', '/profile?tab=bookings',
           'booking_id', p_booking_id)
  from public.bookings where id = p_booking_id and user_id is not null;
end;
$$;

-- =============================================================
-- 4. Booking confirmed / reminder — real URL, correct venue
-- =============================================================
create or replace function public.notify_booking_confirmed()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.user_id is not null
     and new.status = 'confirmed'
     and coalesce(old.status, '') <> 'confirmed' then
    insert into public.notifications (user_id, type, title, body, data)
    select new.user_id, 'booking_confirmed', 'Booking confirmed 🎉',
           'Your booking for ' || a.title || ' is confirmed.',
           public.session_email_details(new.session_id) || jsonb_build_object(
             'url', '/profile?tab=bookings',
             'booking_id', new.id)
    from public.activity_sessions s
    join public.activities a on a.id = s.activity_id
    where s.id = new.session_id;
  end if;
  return new;
end;
$function$;

create or replace function public.send_booking_reminders()
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  insert into public.notifications (user_id, type, title, body, data)
  select b.user_id, 'booking_reminder', 'Class reminder ⏰',
         a.title || ' is coming up on '
           || to_char(s.starts_at at time zone 'Asia/Singapore', 'Dy DD Mon, HH12:MI AM') || '.',
         public.session_email_details(s.id) || jsonb_build_object(
           'url', '/profile?tab=bookings',
           'booking_id', b.id)
  from public.bookings b
  join public.activity_sessions s on s.id = b.session_id
  join public.activities a on a.id = s.activity_id
  where b.status = 'confirmed' and b.reminded_at is null
    and s.starts_at between now() and now() + interval '36 hours';

  update public.bookings b set reminded_at = now()
  from public.activity_sessions s
  where s.id = b.session_id and b.status = 'confirmed' and b.reminded_at is null
    and s.starts_at between now() and now() + interval '36 hours';
end;
$$;

-- =============================================================
-- 5. Post-activity check-in — name the class, link to it
-- =============================================================
create or replace function public.send_class_followups()
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  insert into public.notifications (user_id, type, title, body, data)
  select b.user_id, 'class_followup', 'How was the class? ⭐',
         'Hope you enjoyed ' || a.title || '! Leave a review to help other families.',
         jsonb_strip_nulls(jsonb_build_object(
           'activity_id', a.id,
           'activity_name', a.title,
           -- The review form lives on the activity page, under #reviews.
           'url', case when a.slug is not null
                       then '/activity?slug=' || a.slug || '#reviews'
                       else '/explore' end,
           'rebook_url', case when a.slug is not null
                              then '/book?slug=' || a.slug
                              else '/explore' end
         ))
  from public.bookings b
  join public.activity_sessions s on s.id = b.session_id
  join public.activities a on a.id = s.activity_id
  where b.status in ('confirmed', 'completed') and b.followed_up_at is null
    and s.ends_at between now() - interval '24 hours' and now()
    and b.user_id is not null;

  update public.bookings b set followed_up_at = now()
  from public.activity_sessions s
  where s.id = b.session_id and b.status in ('confirmed', 'completed')
    and b.followed_up_at is null
    and s.ends_at between now() - interval '24 hours' and now();
end;
$$;

commit;
