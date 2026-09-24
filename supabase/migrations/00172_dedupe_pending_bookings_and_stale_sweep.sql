-- Nothing stopped a parent from creating a new set of `pending` booking rows
-- every time they tried to pay for the same session — a declined card, a
-- closed Stripe tab, or just clicking "Book" again from the activity page
-- (rather than resuming the existing attempt from My Bookings) each inserted
-- a fresh row via book_party, none of which ever got cleaned up. Two more
-- pieces close the loop, alongside this one:
--   1. This migration: book_party now looks for an existing pending, unpaid
--      attempt on the same session before inserting anything — found, it
--      hands back that same group_id/status instead of creating new rows.
--      /api/bookings/checkout already knows how to resume payment on an
--      existing group, so nothing on the frontend needs to change.
--   2. app/api/webhooks/stripe/route.ts's `checkout.session.expired` case
--      now also cancels the `bookings` rows (native or Wix-linked) that
--      checkout was for, mirroring what it already did for
--      `event_ticket_orders` — most abandoned attempts clear within ~30 min
--      of Stripe giving up on them.
--   3. The `cancel-stale-pending-bookings` cron below: a backstop for
--      anything (1) can't catch (same session, already resumed once, so
--      there's nothing new to dedupe against) and (2) misses (a webhook
--      delivery failure, the endpoint being down) — sweeps anything still
--      `pending` well past Stripe's own ~30 minute session lifetime.

begin;

create or replace function public.book_party(
  p_session_id  uuid,
  p_child_id    uuid default null,
  p_guest_names text[] default '{}',
  p_policies    uuid[] default '{}',
  p_medical     text default null,
  p_info        text default null
)
returns table (group_id uuid, status text, waitlisted_count int)
language plpgsql
security definer
set search_path to 'public'
as $function$
#variable_conflict use_column
declare
  v_user          uuid := auth.uid();
  v_seats         int  := 1 + coalesce(array_length(p_guest_names, 1), 0);
  v_group         uuid := gen_random_uuid();
  v_existing_group uuid;
  v_session       record;
  v_child         uuid;
  v_status        text;
  v_id            uuid;
  v_i             int;
  v_any_pending   boolean := false;
  v_any_confirmed boolean := false;
  v_waitlisted_count int := 0;
  v_ret           text;
begin
  if v_user is null then
    raise exception 'Please log in again to book';
  end if;
  if v_seats < 1 or v_seats > 6 then
    raise exception 'You can book between 1 and 6 places at a time';
  end if;

  select s.id, s.activity_id, s.capacity, a.provider_id, a.bookings_paused
    into v_session
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  where s.id = p_session_id;
  if not found then
    raise exception 'That class time is no longer available — please pick another';
  end if;
  if coalesce(v_session.bookings_paused, false) then
    raise exception 'Bookings for this class are currently paused.';
  end if;

  if p_child_id is not null then
    select c.id into v_child
    from public.children c
    where c.id = p_child_id and c.parent_id = v_user;
    if v_child is null then
      raise exception 'That child is no longer on your profile — pick another';
    end if;
  end if;

  -- Already have an unpaid attempt on this exact session (a failed card, an
  -- abandoned Stripe tab, or just retrying)? Hand it back instead of
  -- inserting another one — /api/bookings/checkout resumes payment on an
  -- existing group the same way it always could. Deliberately scoped to
  -- 'pending' only, not 'waitlisted': a waitlisted attempt has nothing to
  -- dedupe against (no payment pending), and a parent retrying it is
  -- legitimately checking whether a seat has opened up.
  select b.booking_group_id into v_existing_group
  from public.bookings b
  where b.user_id = v_user
    and b.session_id = p_session_id
    and b.status = 'pending'
    and b.payment_status = 'none'
  limit 1;

  if v_existing_group is not null then
    v_group := v_existing_group;
    select
      bool_or(status = 'pending'),
      bool_or(status = 'confirmed'),
      count(*) filter (where status = 'waitlisted')
    into v_any_pending, v_any_confirmed, v_waitlisted_count
    from public.bookings
    where booking_group_id = v_group;
  else
    -- No capacity gate here. handle_booking_insert waitlists each row that
    -- doesn't fit, in order, so the party is taken as far as the session allows.
    for v_i in 1..v_seats loop
      insert into public.bookings (user_id, session_id, child_id, guest_name, policies_accepted,
                                   medical_disclosure, info_response, booking_group_id)
      values (
        v_user,
        p_session_id,
        case when v_i = 1 then v_child else null end,
        case when v_i = 1 then null
             else coalesce(nullif(btrim(p_guest_names[v_i - 1]), ''), 'Guest child') end,
        coalesce(p_policies, '{}'::uuid[]),
        case when v_i = 1 then nullif(btrim(p_medical), '') else null end,
        case when v_i = 1 then nullif(btrim(p_info), '') else null end,
        v_group
      )
      returning bookings.id, bookings.status into v_id, v_status;

      if v_status = 'waitlisted' then
        v_waitlisted_count := v_waitlisted_count + 1;
      elsif v_status = 'pending' then
        v_any_pending := true;
      elsif v_status = 'confirmed' then
        v_any_confirmed := true;
      end if;
    end loop;
  end if;

  -- Return contract read by the parent app (see file header): prefer
  -- 'pending' (something needs paying, send the party to Stripe), else
  -- 'confirmed' as soon as any seat is genuinely in, only 'waitlisted' when
  -- nothing fit at all. waitlisted_count is the leftover for the caller to
  -- show alongside a non-'waitlisted' status.
  if v_any_pending then
    v_ret := 'pending';
  elsif v_any_confirmed then
    v_ret := 'confirmed';
  else
    v_ret := 'waitlisted';
  end if;

  return query select v_group, v_ret, v_waitlisted_count;
end;
$function$;

grant execute on function public.book_party(uuid, uuid, text[], uuid[], text, text) to authenticated;

-- Backstop for a booking the checkout.session.expired webhook never reached
-- (delivery failure, endpoint outage) or that was never sent to Stripe at all
-- (the app errored between inserting the row and creating the session). Runs
-- entirely inside Postgres via pg_cron, same as refresh-recommendations and
-- refresh-activity-popularity (00003) — no Edge Function invocation, no
-- external request, nothing outside what the project already runs.
-- 45 minutes gives Stripe's own ~30 minute session expiry room to fire the
-- webhook first; this only ever catches what that missed.
select cron.unschedule(jobid) from cron.job
 where jobname = 'cancel-stale-pending-bookings';
select cron.schedule('cancel-stale-pending-bookings', '*/15 * * * *', $$
  update public.bookings
  set status = 'cancelled'
  where status = 'pending'
    and payment_status = 'none'
    and created_at < now() - interval '45 minutes';
$$);

notify pgrst, 'reload schema';

commit;
