-- 00216_provider_bookings_table.sql
--
-- Vendor Bookings page, "Tabular view": every booking across ALL of the
-- provider's sessions in one read, so the table can filter, sort and group
-- them together. provider_session_roster only ever returns one session.
--
-- One row per booking GROUP: a multi-child party (bookings sharing a
-- booking_group_id, 00084) is a single row whose `children` array carries each
-- seat with its own status, so the table can show the children and their
-- confirmation statuses side by side. A plain booking is a group of one.
--
-- Read-only and security definer, scoped to the caller's own provider the same
-- way provider_session_roster is. Sessions starting before p_from are left out;
-- the page asks for the last 30 days onward and caps the result at p_limit.
--
-- Idempotent.

begin;

drop function if exists public.provider_bookings_table(uuid, timestamptz, integer);

create or replace function public.provider_bookings_table(
  p_provider uuid,
  p_from timestamptz,
  p_limit integer default 2000
)
returns table(
  group_key text, session_id uuid, starts_at timestamptz, activity_id uuid,
  activity_title text, wix_service_type text, location text, user_id uuid,
  parent_name text, parent_contact text, is_manual boolean,
  booked_at timestamptz, children jsonb
)
language plpgsql
stable security definer
set search_path to 'public'
as $function$
#variable_conflict use_column
begin
  if p_provider is null or p_provider not in (select public.user_provider_ids()) then
    raise exception 'not authorized';
  end if;

  return query
    select
      coalesce(b.booking_group_id::text, b.id::text),
      s.id,
      s.starts_at,
      a.id,
      a.title,
      a.wix_service_type,
      coalesce(nullif(btrim(s.studio), ''), nullif(btrim(pl.name), ''), nullif(btrim(a.address), '')),
      b.user_id,
      par.full_name,
      max(b.guest_contact),
      bool_and(b.user_id is null and b.guest_name is not null),
      min(b.created_at),
      jsonb_agg(
        jsonb_build_object(
          'booking_id', b.id,
          'name', public.booking_display_name(c.name, b.guest_name, par.full_name),
          'age_months', case when c.date_of_birth is not null
                             then public.child_age_months(c.date_of_birth) end,
          'status', b.status,
          'waitlist_position', b.waitlist_position,
          'child_id', b.child_id,
          'has_medical', b.medical_disclosure is not null,
          'medical_disclosure', b.medical_disclosure,
          'info_response', b.info_response,
          'policies_accepted', (select count(*)::int from public.booking_policy_acceptances bpa
                                 where bpa.booking_id = b.id),
          'attendance_status', at.status,
          'paid_via', case
            when b.payment_status = 'refunded' then 'refunded'
            when b.package_purchase_id is not null then 'credit'
            when exists (select 1 from public.make_up_tokens mt
                          where mt.redeemed_booking_id = b.id) then 'token'
            when b.payment_status = 'paid' then 'cash'
            when coalesce(s.price, a.price, 0) = 0 then 'free'
            else 'none'
          end
        )
        order by b.waitlist_position nulls first, b.created_at
      )
    from public.bookings b
    join public.activity_sessions s on s.id = b.session_id
    join public.activities a on a.id = s.activity_id
    left join public.provider_locations pl on pl.id = a.location_id
    left join public.children c on c.id = b.child_id
    left join public.parent_profiles par on par.id = b.user_id
    left join public.attendance at on at.booking_id = b.id
    where a.provider_id = p_provider
      and s.starts_at >= p_from
    group by coalesce(b.booking_group_id::text, b.id::text), s.id, s.starts_at,
             a.id, a.title, a.wix_service_type,
             coalesce(nullif(btrim(s.studio), ''), nullif(btrim(pl.name), ''), nullif(btrim(a.address), '')),
             b.user_id, par.full_name
    order by s.starts_at, 1
    limit greatest(coalesce(p_limit, 2000), 1);
end;
$function$;

grant execute on function public.provider_bookings_table(uuid, timestamptz, integer) to authenticated;

notify pgrst, 'reload schema';

commit;
