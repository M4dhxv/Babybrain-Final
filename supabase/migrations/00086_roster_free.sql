-- 00086_roster_free.sql
--
-- 00085 gave provider_session_roster a `paid_via` column but still returned
-- 'none' for a booking on a FREE class — which the vendor UI then showed as
-- "Unpaid", even though there was never anything to pay. Add a 'free' case
-- (session price first, then the activity's — same resolution the booking
-- trigger uses) so a $0 class reads "Free" instead.
--
-- Rebuilt in full from the 00085 body; only v_price and the new CASE arm are
-- added. Idempotent.

drop function if exists public.provider_session_roster(uuid);

create or replace function public.provider_session_roster(p_session_id uuid)
returns table(
  booking_id uuid, status text, payment_status text, child_name text,
  child_age_months integer, has_medical boolean, waitlist_position integer,
  attendance_status text, child_id uuid, skill_level text, is_manual boolean,
  user_id uuid, parent_name text, medical_disclosure text,
  policies_accepted integer, info_response text, paid_via text
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
           b.guest_name is not null,
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
           end
    from public.bookings b
    left join public.children c on c.id = b.child_id
    left join public.parent_profiles par on par.id = b.user_id
    left join public.attendance at on at.booking_id = b.id
    left join public.child_skill_levels sl on sl.child_id = b.child_id and sl.activity_id = v_activity
    where b.session_id = p_session_id
    order by b.waitlist_position nulls first, b.created_at;
end;
$function$;
