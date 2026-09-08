-- 00109_roster_manual_vs_party_seat.sql
--
-- QA follow-up on 00091 ("when a booking is added manually, can't edit or
-- delete"). The roster's is_manual was `guest_name is not null` — but a
-- multi-child party (00084) gives every companion seat a guest_name too
-- (child_id null, "Guest child" until the parent renames it). So a real
-- parent's party seat was being flagged "Manual" on the roster and, worse,
-- was offered the Edit/Delete-entry actions that belong only to the
-- vendor's own offline records. The DELETE policy (00091) is `user_id is
-- null`, so a delete would have failed anyway — but the button should never
-- have been there.
--
-- A true manual entry has no parent account at all: user_id is null. That
-- is exactly what the DELETE policy checks, so is_manual now matches it.
--
-- Also adds group_primary_name: for a companion seat of a party, the name
-- of the seat that carries the actual child. The roster shows this as a
-- "With <name>" tag in place of the "Manual" one, so the vendor can see the
-- seat belongs to a parent's group booking.
--
-- Rebuilt in full from the 00106 body; only the two changes above are new.
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
begin
  select a.provider_id, a.id, coalesce(s.price, a.price)
    into v_provider, v_activity, v_price
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  where s.id = p_session_id;

  if v_provider is null or v_provider not in (select public.user_provider_ids()) then
    raise exception 'not authorized';
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
    where b.session_id = p_session_id
    order by b.waitlist_position nulls first, b.created_at;
end;
$function$;

notify pgrst, 'reload schema';

commit;
