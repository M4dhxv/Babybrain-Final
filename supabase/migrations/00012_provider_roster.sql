-- BabyBrain Phase 2 — Provider session roster
-- Vendors legitimately need attendee names/ages for their own sessions, but
-- RLS on `children` only exposes a child to its parent. This security-definer
-- RPC returns the roster for a session the caller's provider owns (membership
-- guarded), the same pattern as provider_analytics. No table/RLS changes.

create or replace function public.provider_session_roster(p_session_id uuid)
returns table (
  booking_id uuid,
  status text,
  payment_status text,
  child_name text,
  child_age_months int,
  has_medical boolean,
  waitlist_position int,
  attendance_status text
)
language plpgsql stable security definer set search_path = public as $$
declare v_provider uuid;
begin
  select a.provider_id into v_provider
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
           coalesce(c.name, 'Guest'),
           case when c.date_of_birth is not null
                then public.child_age_months(c.date_of_birth) end,
           b.medical_disclosure is not null,
           b.waitlist_position,
           at.status
    from public.bookings b
    left join public.children c on c.id = b.child_id
    left join public.attendance at on at.booking_id = b.id
    where b.session_id = p_session_id
    order by b.waitlist_position nulls first, b.created_at;
end;
$$;
