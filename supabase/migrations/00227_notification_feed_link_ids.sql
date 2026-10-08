-- 00227_notification_feed_link_ids.sql
--
-- The vendor Notifications tab was display-only. To make each entry open the
-- thing it describes, the feed now also returns the ids to link to:
--   booking / waitlist / cancellation -> booking_id + session_id (+ activity_id)
--   review                            -> review_id (+ activity_id)
--   token_issued                      -> token_id
--
-- The return type changes, so the function is dropped and recreated. The
-- branches and filters are otherwise identical to 00080, and still mirror
-- provider_notification_unread_count (00139).

begin;

drop function if exists public.provider_notification_feed(uuid, integer);

create function public.provider_notification_feed(p_provider uuid, p_limit integer default 30)
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
      select 'cancellation'::text, b.updated_at, coalesce(c.name, b.guest_name, 'Guest')::text, a.title, null::text,
             b.id, s.id, a.id, null::uuid, null::uuid
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
      select 'token_issued'::text, t.created_at, coalesce(c.name, 'A family')::text, null::text, null::text,
             null::uuid, null::uuid, null::uuid, null::uuid, t.id
      from public.make_up_tokens t
      left join public.children c on c.id = t.child_id
      where t.provider_id = p_provider
        and not t.auto_issued
      order by t.created_at desc
      limit p_limit
    )
  ) feed
  order by event_at desc
  limit p_limit;
end;
$$;
grant execute on function public.provider_notification_feed(uuid, integer) to authenticated;

notify pgrst, 'reload schema';

commit;
