-- BabyBrain Phase 2 — Vendor functions, triggers, analytics
-- Reuses Phase 1 helpers (set_updated_at, notifications pipeline).

-- updated_at maintenance on new/extended tables
drop trigger if exists set_updated_at on public.providers;
create trigger set_updated_at before update on public.providers
  for each row execute function public.set_updated_at();
drop trigger if exists set_updated_at on public.subscriptions;
create trigger set_updated_at before update on public.subscriptions
  for each row execute function public.set_updated_at();
drop trigger if exists set_updated_at on public.bookings;
create trigger set_updated_at before update on public.bookings
  for each row execute function public.set_updated_at();

-- =============================================================
-- New provider → create owner membership + free subscription + welcome
-- =============================================================
create or replace function public.handle_new_provider()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.slug is null then
    new.slug := regexp_replace(lower(new.business_name), '[^a-z0-9]+', '-', 'g')
                || '-' || substr(new.id::text, 1, 6);
  end if;
  return new;
end;
$$;

drop trigger if exists before_provider_insert on public.providers;
create trigger before_provider_insert before insert on public.providers
  for each row execute function public.handle_new_provider();

create or replace function public.after_new_provider()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.owner_id is not null then
    insert into public.provider_members (provider_id, user_id, role, status)
    values (new.id, new.owner_id, 'owner', 'active')
    on conflict (provider_id, user_id) do nothing;
  end if;
  insert into public.subscriptions (provider_id, plan) values (new.id, 'free')
  on conflict (provider_id) do nothing;
  return new;
end;
$$;

drop trigger if exists after_provider_insert on public.providers;
create trigger after_provider_insert after insert on public.providers
  for each row execute function public.after_new_provider();

-- =============================================================
-- Booking insert: stamp provider_id + enforce capacity → waitlist
-- =============================================================
create or replace function public.handle_booking_insert()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_capacity int;
  v_taken int;
  v_provider uuid;
begin
  select a.provider_id, s.capacity into v_provider, v_capacity
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  where s.id = new.session_id;

  new.provider_id := coalesce(new.provider_id, v_provider);

  if v_capacity is not null then
    select count(*) into v_taken from public.bookings
    where session_id = new.session_id and status in ('pending','confirmed');
    if v_taken >= v_capacity then
      new.status := 'waitlisted';
      select coalesce(max(waitlist_position), 0) + 1 into new.waitlist_position
      from public.bookings where session_id = new.session_id and status = 'waitlisted';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists before_booking_insert on public.bookings;
create trigger before_booking_insert before insert on public.bookings
  for each row execute function public.handle_booking_insert();

-- =============================================================
-- Booking cancelled → auto-promote the next waitlisted entry
-- =============================================================
create or replace function public.handle_booking_cancel()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_next uuid;
begin
  if new.status = 'cancelled' and old.status in ('pending','confirmed') then
    select id into v_next from public.bookings
    where session_id = new.session_id and status = 'waitlisted'
    order by waitlist_position nulls last, created_at limit 1;
    if v_next is not null then
      update public.bookings
      set status = 'confirmed', waitlist_position = null
      where id = v_next;
      insert into public.notifications (user_id, type, title, body, data)
      select user_id, 'waitlist_promoted', 'A spot opened up!',
             'You''ve been moved off the waitlist into a confirmed booking.',
             jsonb_build_object('url', '/dashboard/bookings', 'booking_id', v_next)
      from public.bookings where id = v_next;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists after_booking_cancel on public.bookings;
create trigger after_booking_cancel after update of status on public.bookings
  for each row execute function public.handle_booking_cancel();

-- =============================================================
-- Manager action: promote a specific waitlisted booking
-- =============================================================
create or replace function public.promote_waitlist_entry(p_booking_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_provider uuid;
begin
  select provider_id into v_provider from public.bookings where id = p_booking_id;
  if v_provider is null or v_provider not in (select public.user_manage_provider_ids()) then
    raise exception 'not authorized';
  end if;
  update public.bookings set status = 'confirmed', waitlist_position = null
  where id = p_booking_id and status = 'waitlisted';
  insert into public.notifications (user_id, type, title, body, data)
  select user_id, 'waitlist_promoted', 'A spot opened up!',
         'You''ve been moved off the waitlist into a confirmed booking.',
         jsonb_build_object('url', '/dashboard/bookings', 'booking_id', p_booking_id)
  from public.bookings where id = p_booking_id;
end;
$$;

-- =============================================================
-- Vendor action: respond to a review (manager+ only)
-- =============================================================
create or replace function public.respond_to_review(p_review_id uuid, p_response text)
returns void language plpgsql security definer set search_path = public as $$
declare v_provider uuid;
begin
  select a.provider_id into v_provider
  from public.reviews r join public.activities a on a.id = r.activity_id
  where r.id = p_review_id;
  if v_provider is null or v_provider not in (select public.user_manage_provider_ids()) then
    raise exception 'not authorized';
  end if;
  update public.reviews
  set provider_response = p_response, provider_responded_at = now()
  where id = p_review_id;
end;
$$;

-- =============================================================
-- Dashboard KPIs (Overview screen)
-- =============================================================
create or replace function public.provider_overview(p_provider uuid)
returns table (
  active_listings int,
  upcoming_bookings int,
  pending_waitlist int,
  profile_views_30d int,
  revenue numeric
)
language sql stable security definer set search_path = public as $$
  select
    (select count(*)::int from public.activities
       where provider_id = p_provider and is_published and archived_at is null),
    (select count(*)::int from public.bookings b
       join public.activity_sessions s on s.id = b.session_id
       where b.provider_id = p_provider and b.status = 'confirmed' and s.starts_at > now()),
    (select count(*)::int from public.bookings
       where provider_id = p_provider and status = 'waitlisted'),
    (select count(*)::int from public.listing_events
       where provider_id = p_provider and type in ('profile_view','listing_view')
         and created_at > now() - interval '30 days'),
    (select coalesce(sum(amount), 0) from public.bookings
       where provider_id = p_provider and payment_status = 'paid');
$$;

-- =============================================================
-- Analytics (top age group, popular day/time, location ranking)
-- =============================================================
create or replace function public.provider_analytics(
  p_provider uuid, p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_from timestamptz := coalesce(p_from, current_date - 90);
  v_to   timestamptz := coalesce(p_to,   current_date) + 1;
  result jsonb;
begin
  if p_provider not in (select public.user_provider_ids()) then
    raise exception 'not authorized';
  end if;

  select jsonb_build_object(
    'total_bookings', (select count(*) from public.bookings
       where provider_id = p_provider and created_at >= v_from and created_at < v_to),
    'attendance_rate', (
      select round(100.0 * count(*) filter (where at.status = 'present') /
             nullif(count(*), 0), 1)
      from public.attendance at join public.bookings b on b.id = at.booking_id
      where b.provider_id = p_provider and at.marked_at >= v_from and at.marked_at < v_to),
    'top_age_group', (
      select to_jsonb(t) from (
        select case
                 when public.child_age_months(c.date_of_birth) < 12 then '0-1y'
                 when public.child_age_months(c.date_of_birth) < 36 then '1-3y'
                 when public.child_age_months(c.date_of_birth) < 72 then '3-6y'
                 else '6y+' end as band,
               count(*) as bookings
        from public.bookings b join public.children c on c.id = b.child_id
        where b.provider_id = p_provider and b.created_at >= v_from and b.created_at < v_to
        group by band order by bookings desc limit 1) t),
    'popular_slots', (
      select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (
        select lower(trim(to_char(s.starts_at at time zone 'Asia/Singapore', 'Dy'))) as day,
               public.time_of_day(s.starts_at) as time_of_day,
               count(*) as bookings
        from public.bookings b join public.activity_sessions s on s.id = b.session_id
        where b.provider_id = p_provider and b.created_at >= v_from and b.created_at < v_to
        group by day, time_of_day order by bookings desc limit 5) t),
    'location_ranking', (
      select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (
        select coalesce(l.name, 'Unassigned') as location, count(*) as bookings
        from public.bookings b
        join public.activities a on a.id = (
          select activity_id from public.activity_sessions where id = b.session_id)
        left join public.provider_locations l on l.id = a.location_id
        where b.provider_id = p_provider and b.created_at >= v_from and b.created_at < v_to
        group by location order by bookings desc limit 10) t),
    'popular_activities', (
      select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (
        select a.title, count(*) as bookings
        from public.bookings b
        join public.activity_sessions s on s.id = b.session_id
        join public.activities a on a.id = s.activity_id
        where b.provider_id = p_provider and b.created_at >= v_from and b.created_at < v_to
        group by a.title order by bookings desc limit 5) t)
  ) into result;
  return result;
end;
$$;
