-- 00118_course_roster_via_anchor.sql
--
-- A Wix COURSE enrolment is booked once, against a single course-wide
-- "anchor" activity_sessions row (wix_slot_key 'wixcourse:<scheduleId>', see
-- courseAnchorSlotKey in lib/wix/client.ts + resolveWixSlot's COURSE branch
-- in lib/wix/sync.ts) — every calendar occurrence the vendor actually sees
-- (Schedule grid, the Bookings session picker) is a separate row for that
-- same course, deliberately excluded from those vendor-facing queries
-- (app/api/wix/slots/route.ts, frontends/vendor/src/pages/SchedulePage.tsx).
--
-- provider_session_roster matched `bookings.session_id = p_session_id`
-- directly, so picking any of those occurrence rows — which is the only
-- thing a vendor can ever pick — always returned an empty roster: the real
-- booking rows live under the anchor's id, not the occurrence's. The
-- capacity badge ("2/15") looked fine because it comes from Wix's own
-- remaining-capacity figure (wix_remaining_capacity), mirrored onto every
-- occurrence independently of where bookings actually live locally — so a
-- vendor saw a course with real enrolments but an empty Bookings page and
-- Schedule day-detail popup for it.
--
-- Fix: when the requested session belongs to a COURSE, resolve to that
-- activity's anchor row before matching bookings. Falls back to the
-- requested session id itself if no anchor row exists yet (nobody has
-- reserved/checked out a slot on this course, so there is nothing to find
-- either way). Every other session type is untouched.
--
-- Rebuilt in full from the 00109 body; only the resolution step is new.
-- Idempotent.

begin;

drop function if exists public.provider_session_roster(uuid);

create or replace function public.provider_session_roster(p_session_id uuid)
returns table(
  booking_id uuid, status text, payment_status text, child_name text,
  child_age_months integer, has_medical boolean, waitlist_position integer,
  attendance_status text, child_id uuid, skill_level text, is_manual boolean,
  user_id uuid, parent_name text, medical_disclosure text,
  policies_accepted integer, info_response text, paid_via text,
  waitlist_pay_invited boolean, group_primary_name text
)
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
  v_provider uuid;
  v_activity uuid;
  v_price numeric;
  v_wix_type text;
  v_query_session_id uuid := p_session_id;
begin
  select a.provider_id, a.id, coalesce(s.price, a.price), a.wix_service_type
    into v_provider, v_activity, v_price, v_wix_type
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  where s.id = p_session_id;

  if v_provider is null or v_provider not in (select public.user_provider_ids()) then
    raise exception 'not authorized';
  end if;

  if v_wix_type = 'COURSE' then
    select s2.id into v_query_session_id
    from public.activity_sessions s2
    where s2.activity_id = v_activity
      and s2.wix_slot_key like 'wixcourse:%'
    limit 1;
    v_query_session_id := coalesce(v_query_session_id, p_session_id);
  end if;

  return query
    select b.id,
           b.status,
           b.payment_status,
           public.booking_display_name(c.name, b.guest_name, par.full_name),
           case when c.date_of_birth is not null
                then public.child_age_months(c.date_of_birth) end,
           b.medical_disclosure is not null,
           b.waitlist_position,
           at.status,
           b.child_id,
           sl.level,
           -- A manual entry is the vendor's own offline record: no parent
           -- account. A party companion seat also has a guest_name but keeps
           -- its parent's user_id, so it is not manual.
           b.user_id is null and b.guest_name is not null,
           b.user_id,
           par.full_name,
           b.medical_disclosure,
           (select count(*)::int from public.booking_policy_acceptances bpa
             where bpa.booking_id = b.id),
           b.info_response,
           case
             when b.payment_status = 'refunded' then 'refunded'
             when b.package_purchase_id is not null then 'credit'
             when exists (
               select 1 from public.make_up_tokens mt
               where mt.redeemed_booking_id = b.id
             ) then 'token'
             when b.payment_status = 'paid' then 'cash'
             when coalesce(v_price, 0) = 0 then 'free'
             else 'none'
           end,
           b.waitlist_pay_invited,
           -- For a companion seat of a party (00084), the name on the seat
           -- that carries the real child — shown as a "With <name>" tag.
           case when b.booking_group_id is not null and b.child_id is null then (
             select gc.name
             from public.bookings gb
             join public.children gc on gc.id = gb.child_id
             where gb.booking_group_id = b.booking_group_id
               and gb.child_id is not null
             order by gb.created_at
             limit 1
           ) end
    from public.bookings b
    left join public.children c on c.id = b.child_id
    left join public.parent_profiles par on par.id = b.user_id
    left join public.attendance at on at.booking_id = b.id
    left join public.child_skill_levels sl on sl.child_id = b.child_id and sl.activity_id = v_activity
    where b.session_id = v_query_session_id
    order by b.waitlist_position nulls first, b.created_at;
end;
$function$;

notify pgrst, 'reload schema';

commit;
