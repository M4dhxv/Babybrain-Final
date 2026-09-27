-- 00181_upcoming_sessions_by_day.sql
--
-- upcoming_activity_sessions (00163) capped by raw session *row* count, not
-- days. That's fine for a once-a-week class, but a high-frequency listing
-- (e.g. a "book any half-hour slot" private lesson with a dozen+ openings a
-- day) exhausts the default limit=8 within its very first day — every later
-- day is silently dropped before it ever reaches the client.
--
-- Symptom reported: filtering Explore to a specific date correctly returns
-- such an activity (search_activities' own date filter, migration 00177, is
-- unaffected by this), but opening that activity's own page shows a
-- different "next available" day — its schedule widget (SessionSchedule)
-- only ever had the first day's rows to build `days` from, so it fell back
-- to whichever day happened to fill the row cap, regardless of what was
-- actually searched.
--
-- Recap by distinct upcoming *day* instead: p_limit now bounds how many
-- calendar days (Asia/Singapore) of availability come back, not how many
-- session rows — every session within a qualifying day is included, however
-- many that day has. The default rises from 8 to 14 to comfortably cover
-- SessionSchedule's own VISIBLE_DAYS=6 default view plus its "Show all
-- days" expansion, without being unbounded.
--
-- Idempotent.

begin;

create or replace function public.upcoming_activity_sessions(p_activity_id uuid, p_limit int default 14)
returns table (
  id uuid, activity_id uuid, starts_at timestamptz, ends_at timestamptz,
  capacity int, location_id uuid, price numeric, status text, bookings_paused boolean,
  teacher_name text, studio text, wix_slot_key text, wix_remaining_capacity int,
  created_at timestamptz, allow_cancellation boolean, cancellation_cutoff_hours int,
  cancellation_refund_mode text, allow_rescheduling boolean, reschedule_cutoff_hours int,
  booking_cutoff_minutes int
)
language sql
security definer
stable
set search_path to 'public'
as $function$
  with eligible as (
    select
      s.*,
      dense_rank() over (order by (s.starts_at at time zone 'Asia/Singapore')::date) as day_rank
    from public.activity_sessions s
    where s.activity_id = p_activity_id
      and s.wix_slot_key is null
      and s.bookings_paused = false
      and s.starts_at >= now()
  )
  select
    s.id, s.activity_id, s.starts_at, s.ends_at,
    case when s.capacity is null then null
         else greatest(0, s.capacity - coalesce(b.taken, 0))
    end as capacity,
    s.location_id, s.price, s.status, s.bookings_paused,
    s.teacher_name, s.studio, s.wix_slot_key, s.wix_remaining_capacity,
    s.created_at, s.allow_cancellation, s.cancellation_cutoff_hours,
    s.cancellation_refund_mode, s.allow_rescheduling, s.reschedule_cutoff_hours,
    s.booking_cutoff_minutes
  from eligible s
  left join lateral (
    select count(*) as taken
    from public.bookings b
    where b.session_id = s.id
      and b.status in ('pending', 'confirmed', 'completed')
  ) b on true
  where s.day_rank <= greatest(1, coalesce(p_limit, 14))
  order by s.starts_at;
$function$;

revoke all on function public.upcoming_activity_sessions(uuid, int) from public;
grant execute on function public.upcoming_activity_sessions(uuid, int) to anon, authenticated;

notify pgrst, 'reload schema';

commit;
