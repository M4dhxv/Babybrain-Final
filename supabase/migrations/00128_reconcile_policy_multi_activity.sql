-- 00128_reconcile_policy_multi_activity.sql
--
-- 00115_policy_multi_activity was never recorded in
-- supabase_migrations.schema_migrations, but its end state was already live
-- in prod — provider_policies.activity_ids (array) exists, the singular
-- activity_id column is already gone, session_required_policies already reads
-- the array, and the EXECUTE grants are already in place. Someone applied it
-- by hand outside the tracked migration flow (same shape of gap 00113 hit:
-- its unique index already existed before that migration was ever recorded).
--
-- Running 00115's file verbatim now fails — its backfill UPDATE reads
-- activity_id, which no longer exists. This restates the same end state in a
-- form that's safe regardless of which half already landed, and records
-- 00115 itself so the ledger matches reality instead of permanently flagging
-- it as an unapplied gap (the exact ambiguity that let the waitlist
-- notification fix regress twice — see 00100's changelog).
--
-- Checked before writing this: 5 provider_policies rows exist in prod today,
-- all with activity_ids already null (provider-wide) — so if the out-of-band
-- drop happened before a backfill, nothing currently scoped was lost.

begin;

alter table public.provider_policies add column if not exists activity_ids uuid[];

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'provider_policies' and column_name = 'activity_id'
  ) then
    execute $sql$
      update public.provider_policies
      set activity_ids = array[activity_id]
      where activity_id is not null and activity_ids is null
    $sql$;
    alter table public.provider_policies drop column activity_id;
  end if;
end $$;

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

insert into supabase_migrations.schema_migrations (version, name)
values ('00115', 'policy_multi_activity')
on conflict (version) do nothing;

commit;
