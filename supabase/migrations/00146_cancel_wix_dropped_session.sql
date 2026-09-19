-- 00146_cancel_wix_dropped_session.sql
--
-- A vendor cancelling a class occurrence on Wix used to change nothing here.
-- The sync (reconcileStaleWixSessions) deliberately KEPT a local session Wix no
-- longer offered whenever it had a booking, and did nothing else: the parent's
-- booking stayed confirmed, no email or notification went out, and the dead
-- session kept showing in the vendor's activity schedule and in the parent
-- listing's date pop-out.
--
-- This migration is the database half of the fix (the detection is in
-- lib/wix/sync.ts and its edge-function twin):
--
--   1. cancel_wix_session(session)  — the one place a Wix-dropped occurrence is
--      cancelled. Marks the session cancelled, then cancels every live booking
--      on it AS A VENDOR CANCELLATION (cancelled_by set), so the existing
--      triggers do the rest exactly as if the vendor had cancelled each seat in
--      the portal: the branded class_cancelled email + in-app notification
--      (notify_booking_cancelled, 00143) and the credit / make-up token
--      (compensate_cancelled_booking). Idempotent, and service_role only.
--
--   2. Parents can no longer SEE a cancelled session (RLS), which is what
--      removes it from the listing's date pop-out, "next session" and search
--      (search_activities is an invoker function, so it inherits this). A
--      parent's own bookings list is served by a service-role API, so it keeps
--      its date; my_booking_activities() covers the one browser-side lookup
--      (the make-up token card) that needs the class name behind a hidden
--      session.
--
--   3. Nothing can be booked onto, or moved onto, a cancelled session — a
--      trigger on bookings, so it holds for every path (checkout, party
--      booking, package/token redeem, reschedule, a vendor's manual booking),
--      not just the ones we remembered to patch.
--
-- The `status` column ('scheduled' | 'cancelled') already existed on
-- activity_sessions since 00006 but nothing set or honoured it until now.
-- Idempotent.

begin;

-- =============================================================
-- 1. Parents can't see a cancelled session
-- =============================================================
drop policy if exists "sessions of published activities are public" on public.activity_sessions;
create policy "sessions of published activities are public" on public.activity_sessions
  for select using (
    status is distinct from 'cancelled'
    and exists (
      select 1 from public.activities a
      left join public.providers p on p.id = a.provider_id
      where a.id = activity_sessions.activity_id
        and a.is_published
        and coalesce(p.status, 'active') = 'active'
    )
  );

-- A parent's own bookings list is served by /api/customer/bookings (service
-- role), so it is unaffected. The one browser-side read that still needs the
-- class behind a booking whose session is now hidden is the make-up token card
-- (it names the class the token came from) — this returns just that, for the
-- caller's own bookings only, without exposing the cancelled session itself.
create or replace function public.my_booking_activities(p_booking_ids uuid[])
returns table (booking_id uuid, slug text, title text)
language sql
stable
security definer
set search_path to 'public'
as $$
  select b.id, a.slug, a.title
  from public.bookings b
  join public.activity_sessions s on s.id = b.session_id
  join public.activities a on a.id = s.activity_id
  where b.user_id = auth.uid()
    and b.id = any (p_booking_ids);
$$;

revoke all on function public.my_booking_activities(uuid[]) from public, anon;
grant execute on function public.my_booking_activities(uuid[]) to authenticated;

-- (An earlier draft let a parent see a cancelled session behind their own
-- booking. That leaked the cancelled date into search and the date pop-out for
-- exactly the parents who were told it was cancelled, so it is not kept.)
drop policy if exists "own booked cancelled sessions are visible" on public.activity_sessions;
drop function if exists public.user_booked_session_ids();

-- =============================================================
-- 2. Nothing may be booked onto (or moved onto) a cancelled session
-- =============================================================
create or replace function public.block_booking_on_cancelled_session()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if exists (
    select 1 from public.activity_sessions s
    where s.id = new.session_id and s.status = 'cancelled'
  ) then
    raise exception 'This class has been cancelled and can no longer be booked.'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists booking_block_cancelled_session on public.bookings;
create trigger booking_block_cancelled_session
  before insert or update of session_id on public.bookings
  for each row execute function public.block_booking_on_cancelled_session();

-- =============================================================
-- 3. The single cancel path for an occurrence Wix has dropped
-- =============================================================
-- Returns how many bookings it cancelled (0 when there were none, or when the
-- session was already cancelled — safe to call again).
--
-- The caller (the Wix sync) is responsible for having proved Wix really no
-- longer has the session; this function trusts it. It is therefore callable by
-- service_role only.
create or replace function public.cancel_wix_session(p_session_id uuid)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_activity uuid;
  v_status   text;
  v_actor    uuid;
  v_waitlist integer := 0;
  v_live     integer := 0;
begin
  select s.activity_id, s.status into v_activity, v_status
  from public.activity_sessions s
  where s.id = p_session_id
  for update;

  if not found or v_status = 'cancelled' then
    return 0;
  end if;

  -- bookings.cancelled_by is the flag that makes notify_booking_cancelled send
  -- the vendor-cancellation email (null would mean "parent cancelled it" and
  -- suppress it). There is no portal user here, so borrow the provider's
  -- owner, then any member; a nil uuid is the last resort (the column has no
  -- foreign key) so the flag is never null.
  select coalesce(
           p.owner_id,
           (select m.user_id from public.provider_members m
             where m.provider_id = p.id and m.user_id is not null
             order by m.created_at limit 1),
           '00000000-0000-0000-0000-000000000000'::uuid)
    into v_actor
  from public.activities a
  left join public.providers p on p.id = a.provider_id
  where a.id = v_activity;

  -- Flip the session first: from here on nothing can be booked onto it, and the
  -- waitlist-promotion trigger has nobody left to promote (see below).
  update public.activity_sessions set status = 'cancelled' where id = p_session_id;

  -- Waitlisted seats go first. Cancelling a confirmed booking triggers
  -- handle_booking_cancel, which would otherwise promote the next waitlisted
  -- parent into a class that no longer exists (and email them about it).
  update public.bookings
     set status = 'cancelled',
         cancel_refund_mode = 'refund',
         cancel_reason = 'Class cancelled by the provider on Wix',
         cancelled_by = v_actor
   where session_id = p_session_id and status = 'waitlisted';
  get diagnostics v_waitlist = row_count;

  update public.bookings
     set status = 'cancelled',
         cancel_refund_mode = 'refund',
         cancel_reason = 'Class cancelled by the provider on Wix',
         cancelled_by = v_actor
   where session_id = p_session_id and status in ('pending', 'confirmed');
  get diagnostics v_live = row_count;

  return v_waitlist + v_live;
end;
$$;

revoke all on function public.cancel_wix_session(uuid) from public, anon, authenticated;
grant execute on function public.cancel_wix_session(uuid) to service_role;

notify pgrst, 'reload schema';

commit;
