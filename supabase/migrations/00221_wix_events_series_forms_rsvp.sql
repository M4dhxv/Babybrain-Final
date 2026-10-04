-- 00221_wix_events_series_forms_rsvp.sql
--
-- Wix Events, phase 3: model what Wix actually offers.
--
-- 1. RECURRING SERIES. In Wix a recurring event is a series of separate events that share one
--    `recurringEvents.categoryId`. We mirrored every occurrence as its own activity with a single
--    session, so one weekly class showed up as dozens of activities (BeAlere: 36 for a handful of
--    classes). A series is now ONE activity (activities.wix_series_id) with one session per date
--    (activity_sessions.wix_event_id says which Wix event — and so which ticket types — a date is).
--    The series activity keeps wix_event_id NULL on purpose: the 15-minute sync (Next and Deno
--    copies) only maintains activities that have a wix_event_id, and its "one session per
--    activity" collapse would delete a series' other dates. The reconcile job owns series.
--
-- 2. THE EVENT'S OWN QUESTIONS. wix_events.form_questions holds the questions a parent is asked on
--    the booking page (copied from the vendor's Wix form, with fixed options for dropdown / radio /
--    checkbox controls); their answers are kept on the order (form_response) so a retry can resend
--    them.
--
-- 3. OTHER REGISTRATION TYPES. wix_events records the registration type (TICKETING / RSVP /
--    EXTERNAL / NONE). RSVP events have no tickets: event_rsvps holds a parent's RSVP (the order
--    equivalent). EXTERNAL events send the parent to the organiser's own site
--    (activities.external_booking_url already does that).
--
-- 4. activities.wix_registration_type lets the parent app pick the right booking flow without
--    reading wix_events.
--
-- 5. MULTI-DAY EVENTS. A camp that runs 9am-12pm for five days is ONE Wix event (Mon 9:00 -> Fri 12:00)
--    with tickets like "Single Day" / "3 Day Package". It is now decoded into one session per day
--    (activity_sessions.wix_day = that day), so days can be chosen and booked individually; the days a
--    parent picked are kept on the order (event_ticket_orders.selected_days) and a place is seated on
--    each. party_size is the number of children (a single-day ticket is bought once per child per day,
--    so the ticket count alone no longer says how many children).
--
-- Idempotent.

alter table public.wix_events
  add column if not exists wix_series_id text,
  add column if not exists recurrence_status text,
  add column if not exists registration_type text not null default 'TICKETING',
  add column if not exists registration_status text,
  add column if not exists external_url text,
  add column if not exists rsvp_limit int,
  add column if not exists rsvp_waitlist boolean not null default false,
  -- The RSVP form has a guests control, so a parent may bring additional guests.
  add column if not exists rsvp_allows_guests boolean not null default false,
  add column if not exists form_questions jsonb not null default '[]'::jsonb,
  -- Why this one date cannot take a booking right now ([{code, vendorMessage, parentMessage}]); empty = bookable.
  add column if not exists booking_blockers jsonb not null default '[]'::jsonb;

create index if not exists wix_events_series_idx
  on public.wix_events (provider_id, wix_series_id) where wix_series_id is not null;

alter table public.activities
  add column if not exists wix_series_id text,
  add column if not exists wix_registration_type text;

-- One activity per series per vendor.
create unique index if not exists activities_provider_series_idx
  on public.activities (provider_id, wix_series_id) where wix_series_id is not null;

alter table public.activity_sessions
  add column if not exists wix_event_id uuid references public.wix_events (id) on delete set null,
  -- Multi-day events: the calendar day (in the event's time zone) this session is. NULL for everything else.
  add column if not exists wix_day date;

create index if not exists activity_sessions_wix_day_idx
  on public.activity_sessions (wix_event_id, wix_day) where wix_day is not null;

create index if not exists activity_sessions_wix_event_idx
  on public.activity_sessions (wix_event_id) where wix_event_id is not null;

comment on column public.activity_sessions.wix_event_id is
  'The (local) wix_events row this date is — set on every date of a series activity, and on single events too. Which ticket types apply to a date hangs off this.';

alter table public.event_ticket_orders
  add column if not exists form_response jsonb not null default '{}'::jsonb,
  -- Multi-day events: the days the parent chose (YYYY-MM-DD) and how many children they are for.
  add column if not exists selected_days text[] not null default '{}',
  add column if not exists party_size int;

-- ---------------------------------------------------------------------------------------------
-- RSVPs for Wix RSVP-type events (free, no tickets)
-- ---------------------------------------------------------------------------------------------
create table if not exists public.event_rsvps (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.parent_profiles (id) on delete cascade,
  child_id uuid references public.children (id) on delete set null,
  event_id uuid not null references public.wix_events (id),
  -- yes = attending, waitlist = Wix put them on its waitlist, cancelled = no longer attending.
  status text not null default 'yes' check (status in ('yes', 'waitlist', 'cancelled')),
  guest_count int not null default 0 check (guest_count between 0 and 10),
  guest_names text[] not null default '{}',
  wix_rsvp_id text,
  medical_disclosure text,
  policies_accepted text[] not null default '{}',
  info_response text,
  form_response jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One live RSVP per parent per event (Wix itself refuses the same email twice).
create unique index if not exists event_rsvps_one_live_idx
  on public.event_rsvps (user_id, event_id) where status in ('yes', 'waitlist');
create index if not exists event_rsvps_event_idx on public.event_rsvps (event_id);

alter table public.event_rsvps enable row level security;
drop policy if exists "select own wix event rsvps" on public.event_rsvps;
create policy "select own wix event rsvps" on public.event_rsvps
  for select using (user_id = auth.uid());

drop trigger if exists set_updated_at on public.event_rsvps;
create trigger set_updated_at before update on public.event_rsvps
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- upcoming_activity_sessions: carry each date's Wix event, and never return a cancelled date.
--
-- A series activity's dates each belong to a different Wix event (and so different ticket types),
-- so the parent page needs wix_event_id per session. The function is SECURITY DEFINER, which
-- bypasses the "parents can't see a cancelled session" policy of 00146, so a date cancelled
-- because Wix dropped it would otherwise still be offered — it now filters status itself.
-- Adding a column changes the return type, so the function is dropped and recreated (same
-- arguments, same grants, same ordering and capacity maths as 00181).
-- ---------------------------------------------------------------------------------------------
drop function if exists public.upcoming_activity_sessions(uuid, int);

create function public.upcoming_activity_sessions(p_activity_id uuid, p_limit int default 14)
returns table (
  id uuid, activity_id uuid, starts_at timestamptz, ends_at timestamptz,
  capacity int, location_id uuid, price numeric, status text, bookings_paused boolean,
  teacher_name text, studio text, wix_slot_key text, wix_remaining_capacity int,
  created_at timestamptz, allow_cancellation boolean, cancellation_cutoff_hours int,
  cancellation_refund_mode text, allow_rescheduling boolean, reschedule_cutoff_hours int,
  booking_cutoff_minutes int, wix_event_id uuid, wix_day date
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
      and s.status is distinct from 'cancelled'
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
    s.booking_cutoff_minutes, s.wix_event_id, s.wix_day
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
