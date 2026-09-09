-- 00115_policy_multi_activity.sql
--
-- Waivers & consents (provider_policies) could only be pinned to a SINGLE
-- activity (activity_id) or left provider-wide (activity_id null → all
-- classes). A vendor with, say, three classes that share one liability waiver
-- but two that don't had no way to scope it to just those three.
--
-- Widen `activity_id` to a list, exactly the way packages went in 00068
-- (packages.activity_id → packages.activity_ids uuid[]). null / empty still
-- means "every class this provider runs".

alter table public.provider_policies add column if not exists activity_ids uuid[];

update public.provider_policies
set activity_ids = array[activity_id]
where activity_id is not null and activity_ids is null;

alter table public.provider_policies drop column if exists activity_id;

-- Same function as 00044, only the single-activity match swapped for an
-- array membership check (null / empty array still means "all classes").
create or replace function public.session_required_policies(p_session_id uuid)
returns setof public.provider_policies
language sql
stable
set search_path to 'public'
as $$
  select pp.*
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  join public.provider_policies pp
    on pp.provider_id = a.provider_id
   and (
     pp.activity_ids is null
     or array_length(pp.activity_ids, 1) is null
     or a.id = any(pp.activity_ids)
   )
  where s.id = p_session_id
    and pp.active
  order by pp.sort_order, pp.created_at;
$$;

grant execute on function public.session_required_policies(uuid) to anon, authenticated;
