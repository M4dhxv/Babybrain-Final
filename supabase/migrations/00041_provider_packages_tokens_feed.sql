-- Vendor portal: Notifications, Packages and Make-up Tokens tabs.
-- All three need vendor-side reads across parent-owned rows (children,
-- parent_profiles) that RLS locks to "own row only" — same situation
-- provider_session_roster / provider_recent_bookings already solve, so
-- these follow that exact pattern: security-definer RPCs, membership
-- checked against user_provider_ids(). No table or RLS changes.

-- 1. A unified recent-activity feed for the vendor Notifications tab:
--    new bookings, waitlist joins, cancellations, reviews and issued
--    make-up tokens, merged and ordered by recency. Token *redemption*
--    isn't included — make_up_tokens has no redeemed_at, only a status
--    column, so there's no reliable timestamp for that event.
create or replace function public.provider_notification_feed(p_provider uuid, p_limit integer default 30)
returns table (
  kind text,
  event_at timestamptz,
  actor_name text,
  activity_title text,
  detail text
)
language plpgsql
stable security definer
set search_path = public
as $$
begin
  if p_provider not in (select public.user_provider_ids()) then
    raise exception 'not authorized';
  end if;

  return query
  select * from (
    (
      select 'booking'::text, b.created_at, coalesce(c.name, b.guest_name, 'Guest')::text, a.title, null::text
      from public.bookings b
      join public.activity_sessions s on s.id = b.session_id
      join public.activities a on a.id = s.activity_id
      left join public.children c on c.id = b.child_id
      where b.provider_id = p_provider and b.status in ('confirmed', 'completed')
      order by b.created_at desc
      limit p_limit
    )
    union all
    (
      select 'waitlist'::text, b.created_at, coalesce(c.name, b.guest_name, 'Guest')::text, a.title, null::text
      from public.bookings b
      join public.activity_sessions s on s.id = b.session_id
      join public.activities a on a.id = s.activity_id
      left join public.children c on c.id = b.child_id
      where b.provider_id = p_provider and b.status = 'waitlisted'
      order by b.created_at desc
      limit p_limit
    )
    union all
    (
      select 'cancellation'::text, b.updated_at, coalesce(c.name, b.guest_name, 'Guest')::text, a.title, null::text
      from public.bookings b
      join public.activity_sessions s on s.id = b.session_id
      join public.activities a on a.id = s.activity_id
      left join public.children c on c.id = b.child_id
      where b.provider_id = p_provider and b.status = 'cancelled'
      order by b.updated_at desc
      limit p_limit
    )
    union all
    (
      select 'review'::text, r.created_at, coalesce(par.full_name, 'A parent')::text, a.title, r.rating::text
      from public.reviews r
      join public.activities a on a.id = r.activity_id
      left join public.parent_profiles par on par.id = r.user_id
      where a.provider_id = p_provider
      order by r.created_at desc
      limit p_limit
    )
    union all
    (
      select 'token_issued'::text, t.created_at, coalesce(c.name, 'A family')::text, null::text, null::text
      from public.make_up_tokens t
      left join public.children c on c.id = t.child_id
      where t.provider_id = p_provider
      order by t.created_at desc
      limit p_limit
    )
  ) feed
  order by event_at desc
  limit p_limit;
end;
$$;
grant execute on function public.provider_notification_feed(uuid, integer) to authenticated;

-- 2. Package purchases (who bought what, credits remaining) for the
--    vendor Packages tab — currently nowhere in the vendor UI.
create or replace function public.provider_package_purchases(p_provider uuid)
returns table (
  purchase_id uuid,
  package_name text,
  buyer_name text,
  credits_total integer,
  credits_remaining integer,
  status text,
  created_at timestamptz,
  expires_at timestamptz
)
language plpgsql
stable security definer
set search_path = public
as $$
begin
  if p_provider not in (select public.user_provider_ids()) then
    raise exception 'not authorized';
  end if;

  return query
  select pp.id, pk.name, coalesce(par.full_name, 'Parent')::text,
         pp.credits_total, pp.credits_remaining, pp.status,
         pp.created_at, pp.expires_at
  from public.package_purchases pp
  join public.packages pk on pk.id = pp.package_id
  left join public.parent_profiles par on par.id = pp.user_id
  where pp.provider_id = p_provider
  order by pp.created_at desc;
end;
$$;
grant execute on function public.provider_package_purchases(uuid) to authenticated;

-- 3. Every make-up token this provider has issued, for the vendor
--    Make-up Tokens tab — issuance already existed (BookingsPage) but
--    there was no list of outstanding/redeemed tokens anywhere.
create or replace function public.provider_make_up_tokens(p_provider uuid)
returns table (
  token_id uuid,
  child_name text,
  parent_name text,
  origin_activity_title text,
  origin_session_at timestamptz,
  status text,
  created_at timestamptz,
  expires_at timestamptz
)
language plpgsql
stable security definer
set search_path = public
as $$
begin
  if p_provider not in (select public.user_provider_ids()) then
    raise exception 'not authorized';
  end if;

  return query
  select t.id, coalesce(c.name, 'Guest')::text, coalesce(par.full_name, 'Parent')::text,
         a.title, s.starts_at, t.status, t.created_at, t.expires_at
  from public.make_up_tokens t
  left join public.children c on c.id = t.child_id
  left join public.parent_profiles par on par.id = t.user_id
  left join public.bookings b on b.id = t.origin_booking_id
  left join public.activity_sessions s on s.id = b.session_id
  left join public.activities a on a.id = s.activity_id
  where t.provider_id = p_provider
  order by t.created_at desc;
end;
$$;
grant execute on function public.provider_make_up_tokens(uuid) to authenticated;

notify pgrst, 'reload schema';
