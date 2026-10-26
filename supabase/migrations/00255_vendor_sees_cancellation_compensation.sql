-- 00255_vendor_sees_cancellation_compensation.sql
--
-- What a cancelled booking gave back to the family, visible to the vendor
-- (client, 2026-10-26). Since 00080 a cancellation hands the parent a package
-- credit (credit booking) or a make-up token (paid booking, or a pack that can
-- no longer be used), but the vendor portal deliberately hid the automatic
-- tokens, and nothing showed a returned credit.
--
--  1. provider_make_up_tokens(p_provider, p_include_auto): the Make-up tokens
--     page can ask for the automatic tokens too (and gets an auto_issued flag).
--  2. provider_notification_feed(..., p_compensation): when asked, the feed also
--     lists automatic tokens and a new 'credit_returned' event ("a package credit
--     went back to <family>").
--  3. provider_booking_outcomes(p_provider, p_booking_ids): per cancelled
--     booking, what the family got back - for the Bookings views.
--
-- Compatibility (see 00247): every new behaviour is OPT-IN through a defaulted
-- parameter, so a vendor portal built before this change calls the same
-- signatures and gets exactly what it got before - no new kinds, same rows.
-- Safe to apply before, during or after the portal ships.
--
-- Idempotent.

begin;

-- 1. The tokens list.
drop function if exists public.provider_make_up_tokens(uuid);
drop function if exists public.provider_make_up_tokens(uuid, boolean);
create function public.provider_make_up_tokens(p_provider uuid, p_include_auto boolean default false)
returns table (
  token_id uuid,
  child_name text,
  parent_name text,
  origin_activity_title text,
  origin_session_at timestamptz,
  status text,
  created_at timestamptz,
  expires_at timestamptz,
  auto_issued boolean
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
         a.title, s.starts_at, t.status, t.created_at, t.expires_at, t.auto_issued
  from public.make_up_tokens t
  left join public.children c on c.id = t.child_id
  left join public.parent_profiles par on par.id = t.user_id
  left join public.bookings b on b.id = t.origin_booking_id
  left join public.activity_sessions s on s.id = b.session_id
  left join public.activities a on a.id = s.activity_id
  where t.provider_id = p_provider
    and (p_include_auto or not t.auto_issued)
  order by t.created_at desc;
end;
$$;
revoke all on function public.provider_make_up_tokens(uuid, boolean) from public, anon;
grant execute on function public.provider_make_up_tokens(uuid, boolean) to authenticated;

-- 2. The feed: 00247's function plus p_compensation.
drop function if exists public.provider_notification_feed(uuid, integer, boolean);
drop function if exists public.provider_notification_feed(uuid, integer, boolean, boolean);
create function public.provider_notification_feed(
  p_provider uuid,
  p_limit integer default 30,
  p_waitlist_left boolean default false,
  p_compensation boolean default false
)
returns table (
  kind text,
  event_at timestamptz,
  actor_name text,
  activity_title text,
  detail text,
  booking_id uuid,
  session_id uuid,
  activity_id uuid,
  review_id uuid,
  token_id uuid
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
      select 'booking'::text, b.created_at, coalesce(c.name, b.guest_name, 'Guest')::text, a.title, null::text,
             b.id, s.id, a.id, null::uuid, null::uuid
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
      select 'waitlist'::text, b.created_at, coalesce(c.name, b.guest_name, 'Guest')::text, a.title, null::text,
             b.id, s.id, a.id, null::uuid, null::uuid
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
      select 'cancellation'::text, coalesce(b.cancelled_at, b.updated_at), coalesce(c.name, b.guest_name, 'Guest')::text, a.title, null::text,
             b.id, s.id, a.id, null::uuid, null::uuid
      from public.bookings b
      join public.activity_sessions s on s.id = b.session_id
      join public.activities a on a.id = s.activity_id
      left join public.children c on c.id = b.child_id
      where b.provider_id = p_provider and b.status = 'cancelled' and b.waitlist_position is null
      order by coalesce(b.cancelled_at, b.updated_at) desc
      limit p_limit
    )
    union all
    (
      select (case when p_waitlist_left then 'waitlist_left' else 'cancellation' end)::text, coalesce(b.cancelled_at, b.updated_at), coalesce(c.name, b.guest_name, 'Guest')::text, a.title, null::text,
             b.id, s.id, a.id, null::uuid, null::uuid
      from public.bookings b
      join public.activity_sessions s on s.id = b.session_id
      join public.activities a on a.id = s.activity_id
      left join public.children c on c.id = b.child_id
      where b.provider_id = p_provider and b.status = 'cancelled' and b.waitlist_position is not null
      order by coalesce(b.cancelled_at, b.updated_at) desc
      limit p_limit
    )
    union all
    (
      select 'review'::text, r.created_at, coalesce(par.full_name, 'A parent')::text, a.title, r.rating::text,
             null::uuid, null::uuid, a.id, r.id, null::uuid
      from public.reviews r
      join public.activities a on a.id = r.activity_id
      left join public.parent_profiles par on par.id = r.user_id
      where a.provider_id = p_provider
      order by r.created_at desc
      limit p_limit
    )
    union all
    (
      -- detail = 'auto' marks a token the platform issued for a cancellation.
      select 'token_issued'::text, t.created_at, coalesce(c.name, 'A family')::text, ta.title,
             (case when t.auto_issued then 'auto' else null end)::text,
             t.origin_booking_id, tb.session_id, ta.id, null::uuid, t.id
      from public.make_up_tokens t
      left join public.children c on c.id = t.child_id
      left join public.bookings tb on tb.id = t.origin_booking_id
      left join public.activity_sessions ts on ts.id = tb.session_id
      left join public.activities ta on ta.id = ts.activity_id
      where t.provider_id = p_provider
        and (p_compensation or not t.auto_issued)
      order by t.created_at desc
      limit p_limit
    )
    union all
    (
      -- A cancelled package booking whose credit went back on the pack. The
      -- parent's own 'package_credit_returned' notice (00080/00205) is the record.
      select 'credit_returned'::text, coalesce(b.cancelled_at, b.updated_at), coalesce(c.name, b.guest_name, 'A family')::text, a.title, null::text,
             b.id, s.id, a.id, null::uuid, null::uuid
      from public.bookings b
      join public.activity_sessions s on s.id = b.session_id
      join public.activities a on a.id = s.activity_id
      left join public.children c on c.id = b.child_id
      where p_compensation
        and b.provider_id = p_provider and b.status = 'cancelled' and b.package_purchase_id is not null
        and exists (select 1 from public.notifications n
                    where n.user_id = b.user_id and n.type = 'package_credit_returned'
                      and n.data ->> 'booking_id' = b.id::text)
      order by coalesce(b.cancelled_at, b.updated_at) desc
      limit p_limit
    )
  ) feed
  order by 2 desc
  limit p_limit;
end;
$$;
revoke all on function public.provider_notification_feed(uuid, integer, boolean, boolean) from public, anon;
grant execute on function public.provider_notification_feed(uuid, integer, boolean, boolean) to authenticated;

-- 3. What each cancelled booking gave back.
--    outcome: 'token' (a make-up token was issued), 'token_returned' (the
--    make-up token it was paid with came back), 'credit' (a package credit went
--    back), 'refunded' (cash refunded), 'none' (nothing went back).
create or replace function public.provider_booking_outcomes(p_provider uuid, p_booking_ids uuid[])
returns table (booking_id uuid, outcome text)
language plpgsql
stable security definer
set search_path = public
as $$
begin
  if p_provider not in (select public.user_provider_ids()) then
    raise exception 'not authorized';
  end if;

  return query
  select b.id,
    (case
       when exists (select 1 from public.make_up_tokens t where t.origin_booking_id = b.id) then 'token'
       when exists (select 1 from public.notifications n
                    where n.user_id = b.user_id and n.type = 'make_up_token_returned'
                      and n.data ->> 'booking_id' = b.id::text) then 'token_returned'
       when b.package_purchase_id is not null
            and exists (select 1 from public.notifications n
                        where n.user_id = b.user_id and n.type = 'package_credit_returned'
                          and n.data ->> 'booking_id' = b.id::text) then 'credit'
       when b.payment_status = 'refunded' then 'refunded'
       else 'none'
     end)::text
  from public.bookings b
  where b.provider_id = p_provider
    and b.status = 'cancelled'
    and b.id = any (p_booking_ids);
end;
$$;
revoke all on function public.provider_booking_outcomes(uuid, uuid[]) from public, anon;
grant execute on function public.provider_booking_outcomes(uuid, uuid[]) to authenticated;

notify pgrst, 'reload schema';

commit;
