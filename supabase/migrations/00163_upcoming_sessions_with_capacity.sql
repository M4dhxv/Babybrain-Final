-- 00163_upcoming_sessions_with_capacity.sql
--
-- The activity detail page's native (non-Wix) session list used to be two
-- sequential round trips: fetch the sessions, then fetch each one's booked
-- count from /api/public/booked-counts to turn raw `capacity` into spots
-- actually left (useActivityDetail's withRemainingCapacity, frontends/parent
-- /src/lib/data.ts). That second leg can only start once the first has
-- returned, so it's pure added latency on every single activity page view,
-- not just a slow query — found while investigating a report of native
-- activity pages taking 10+ seconds to load even with no concurrent traffic.
--
-- This folds both into one query: same eligibility filters
-- (activity_sessions with a NULL wix_slot_key, bookings_paused = false,
-- starts_at in the future, ordered, capped), same booking-status set
-- /api/public/booked-counts already counts ('pending','confirmed',
-- 'completed' — matching what handle_booking_insert() treats as holding a
-- seat), same public.bookings RLS bypass rationale (a parent can't count
-- another family's bookings directly, so this needs security definer, same
-- as that route needs the service role).
--
-- Idempotent.

begin;

create or replace function public.upcoming_activity_sessions(p_activity_id uuid, p_limit int default 8)
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
  from public.activity_sessions s
  left join lateral (
    select count(*) as taken
    from public.bookings b
    where b.session_id = s.id
      and b.status in ('pending', 'confirmed', 'completed')
  ) b on true
  where s.activity_id = p_activity_id
    and s.wix_slot_key is null
    and s.bookings_paused = false
    and s.starts_at >= now()
  order by s.starts_at
  limit greatest(1, coalesce(p_limit, 8));
$function$;

-- Public, read-only, aggregate-only (no booker identity) — same exposure
-- /api/public/booked-counts already has for any session id, just folded into
-- one call instead of two. Callable signed-out (Explore/activity pages work
-- without an account).
revoke all on function public.upcoming_activity_sessions(uuid, int) from public;
grant execute on function public.upcoming_activity_sessions(uuid, int) to anon, authenticated;

notify pgrst, 'reload schema';

commit;
