-- 00028_roster_user_id.sql
-- The vendor Bookings page has a "Message parent" button that was a dead
-- stub ("Live chat ships in Phase 2") even though GetStream chat has been
-- live for a while. Wiring it up requires the roster to expose the parent's
-- user_id (manual/guest bookings have none, so it's nullable).

drop function if exists public.provider_session_roster(uuid);
create function public.provider_session_roster(p_session_id uuid)
returns table (
  booking_id uuid,
  status text,
  payment_status text,
  child_name text,
  child_age_months integer,
  has_medical boolean,
  waitlist_position integer,
  attendance_status text,
  child_id uuid,
  skill_level text,
  is_manual boolean,
  user_id uuid
)
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
  v_provider uuid;
  v_activity uuid;
begin
  select a.provider_id, a.id into v_provider, v_activity
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
           coalesce(c.name, b.guest_name, 'Guest'),
           case when c.date_of_birth is not null
                then public.child_age_months(c.date_of_birth) end,
           b.medical_disclosure is not null,
           b.waitlist_position,
           at.status,
           b.child_id,
           sl.level,
           b.guest_name is not null,
           b.user_id
    from public.bookings b
    left join public.children c on c.id = b.child_id
    left join public.attendance at on at.booking_id = b.id
    left join public.child_skill_levels sl on sl.child_id = b.child_id and sl.activity_id = v_activity
    where b.session_id = p_session_id
    order by b.waitlist_position nulls first, b.created_at;
end;
$function$;
