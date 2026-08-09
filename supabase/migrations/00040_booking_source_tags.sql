-- 00040_booking_source_tags.sql
--
-- QA: "'confirmed' doesn't add much value as it will be confirmed at the point
-- of booking... is it possible to tag whether a booking is 'New' or 'Repeat'
-- or what type of package it was booked with i.e. 'Trial'/'Drop in'/'Single'/
-- '5 pass pack', '10 pass pack', 'Term'."
--
-- Two pieces:
--
-- 1. New vs Repeat is derivable purely from existing bookings history (has
--    this parent booked with this provider before?) and is added to
--    provider_recent_bookings rather than requiring a schema change.
--
-- 2. Pack type is NOT derivable today. redeem_package_credit inserts the
--    booking but never records which package_purchase paid for it, so a
--    booking made with a pack looks identical to a direct one-off booking.
--    Adding the column here and having the RPC populate it going forward
--    means every booking from this point on carries a real pack name; the
--    exact "Trial vs Drop-in vs Single" distinction the founder listed isn't
--    something the schema can tell apart even after this, since none of
--    those are represented as different package/booking types today — a
--    booking with no package_purchase_id is simply a direct paid booking, and
--    is labelled "Single class" rather than guessed at further.

alter table public.bookings
  add column if not exists package_purchase_id uuid references public.package_purchases(id) on delete set null;

comment on column public.bookings.package_purchase_id is
  'Which package credit paid for this booking, if any. Null for a direct one-off booking.';

-- Re-point redeem_package_credit to record it. Everything else about the
-- function is unchanged from the version this replaces.
create or replace function public.redeem_package_credit(p_purchase_id uuid, p_session_id uuid)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_user uuid := auth.uid();
  v_pur public.package_purchases;
  v_pkg public.packages;
  v_session record;
  v_booking_id uuid;
  v_status text;
begin
  if v_user is null then
    raise exception 'Not authenticated';
  end if;

  select * into v_pur
  from public.package_purchases
  where id = p_purchase_id
    and user_id = v_user
    and status = 'active'
    and credits_remaining > 0
    and (expires_at is null or expires_at > now());
  if not found then
    raise exception 'No credits available on this package (it may have expired)';
  end if;

  select * into v_pkg from public.packages where id = v_pur.package_id;

  select s.id, s.starts_at, s.activity_id, a.provider_id
    into v_session
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  where s.id = p_session_id;

  if v_session.provider_id is null or v_session.provider_id <> v_pur.provider_id then
    raise exception 'This package can only be used for its provider''s classes';
  end if;
  if v_pkg.activity_id is not null and v_pkg.activity_id <> v_session.activity_id then
    raise exception 'This package is limited to a specific class';
  end if;
  if v_pkg.allowed_weekday is not null
     and extract(dow from v_session.starts_at at time zone 'Asia/Singapore') <> v_pkg.allowed_weekday then
    raise exception 'This package can only be redeemed for its designated weekly slot';
  end if;
  if v_pkg.allowed_start_time is not null
     and (v_session.starts_at at time zone 'Asia/Singapore')::time <> v_pkg.allowed_start_time then
    raise exception 'This package can only be redeemed for its designated weekly slot';
  end if;

  insert into public.bookings (user_id, session_id, child_id, package_purchase_id)
  values (v_user, p_session_id, null, p_purchase_id)
  returning id, status into v_booking_id, v_status;

  -- A credit pays for the class, so a paid-class booking confirms immediately
  -- (capacity overflow still waitlists).
  if v_status = 'pending' then
    update public.bookings set status = 'confirmed' where id = v_booking_id;
    v_status := 'confirmed';
  end if;

  update public.package_purchases
  set credits_remaining = credits_remaining - 1,
      status = case when credits_remaining - 1 <= 0 then 'used' else status end
  where id = p_purchase_id;

  return v_status;
end;
$function$;

-- provider_recent_bookings now also returns is_repeat and the pack name (or
-- null for a direct booking). New output columns mean the old signature has
-- to be dropped first — CREATE OR REPLACE can't add columns to a
-- RETURNS TABLE. The vendor dashboard is the only caller, and it's updated in
-- the same change.
drop function if exists public.provider_recent_bookings(uuid, integer);

create function public.provider_recent_bookings(p_provider uuid, p_limit integer default 6)
returns table (
  booking_id uuid,
  child_name text,
  activity_title text,
  starts_at timestamptz,
  status text,
  created_at timestamptz,
  is_repeat boolean,
  package_name text
)
language plpgsql
stable security definer
set search_path to 'public'
as $$
begin
  if p_provider not in (select public.user_provider_ids()) then
    raise exception 'not authorized';
  end if;

  return query
    select
      b.id,
      coalesce(c.name, b.guest_name, 'Guest'),
      a.title,
      s.starts_at,
      b.status,
      b.created_at,
      -- Repeat = this parent has an earlier, non-cancelled booking with this
      -- provider that was made before this one.
      exists (
        select 1 from public.bookings b2
        where b2.provider_id = b.provider_id
          and b2.user_id = b.user_id
          and b2.status <> 'cancelled'
          and b2.created_at < b.created_at
      ),
      pkg.name
    from public.bookings b
    join public.activity_sessions s on s.id = b.session_id
    join public.activities a on a.id = s.activity_id
    left join public.children c on c.id = b.child_id
    left join public.package_purchases pp on pp.id = b.package_purchase_id
    left join public.packages pkg on pkg.id = pp.package_id
    where b.provider_id = p_provider
      and b.status <> 'cancelled'
    order by b.created_at desc
    limit least(coalesce(p_limit, 6), 50);
end;
$$;

grant execute on function public.provider_recent_bookings(uuid, integer) to authenticated;

notify pgrst, 'reload schema';
