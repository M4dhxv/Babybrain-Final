-- 00148_digest_skips_cancelled_sessions.sql
--
-- Follow-up to 00146 (a class cancelled on Wix now marks its session
-- status = 'cancelled'). suggested_activities_for_parent is SECURITY DEFINER, so
-- the RLS that now hides cancelled sessions from parents does not apply to it,
-- and the weekly "suggested activities" digest could still recommend a class
-- that has been cancelled. It now skips cancelled sessions.
--
-- Body is 00120's, plus the one `s.status <> 'cancelled'` line. Idempotent.

begin;

create or replace function public.suggested_activities_for_parent(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with candidates as (
    select
      a.id as activity_id,
      a.slug,
      s.id as session_id,
      s.starts_at,
      s.capacity,
      max(ur.score) as score
    from public.user_recommendations ur
    join public.children c on c.id = ur.child_id and c.parent_id = p_user_id
    join public.activities a on a.id = ur.activity_id and a.is_published
    join public.activity_sessions s on s.activity_id = a.id
      and s.status <> 'cancelled'
      and s.starts_at between now() and now() + interval '7 days'
    where not exists (
      select 1 from public.bookings b
      where b.session_id = s.id and b.user_id = p_user_id and b.status <> 'cancelled'
    )
    group by a.id, a.slug, s.id, s.starts_at, s.capacity
  ),
  open_seats as (
    select c.*
    from candidates c
    where c.capacity is null
      or c.capacity > (
        select count(*) from public.bookings b
        where b.session_id = c.session_id and b.status in ('confirmed', 'pending')
      )
  ),
  -- One session per activity — the highest-scoring, soonest-starting one.
  best_per_activity as (
    select distinct on (activity_id) activity_id, slug, session_id, starts_at, score
    from open_seats
    order by activity_id, score desc, starts_at asc
  ),
  top5 as (
    select * from best_per_activity
    order by score desc, starts_at asc
    limit 5
  )
  select coalesce(
    jsonb_agg(
      public.session_email_details(session_id) || jsonb_build_object('url', '/activity?slug=' || slug)
      order by score desc, starts_at asc
    ),
    '[]'::jsonb
  )
  from top5;
$$;

notify pgrst, 'reload schema';

commit;
