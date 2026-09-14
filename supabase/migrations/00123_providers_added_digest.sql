-- Wire up "providers_added" (announce newly onboarded vendors). Previously
-- completely unwired — app/api/admin/email-flows/route.ts listed it as
-- "Not wired to anything yet." Email content already matched the spec
-- exactly, no template change needed.
--
-- Spec gave no cadence (unlike every other flow, which said "(immediate)" or
-- a schedule) — a literal per-provider-insert trigger would mass-email every
-- parent on every single vendor signup, so this batches weekly and only
-- sends if at least one qualifying provider was added in that window.
--
-- "Added" = providers.status = 'active' (draft/pending providers aren't
-- visible to parents yet) with created_at in the last 7 days, and at least
-- one published activity — otherwise "check them out" links to nothing.

create or replace function public.send_providers_added_digest()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  select count(*) into v_count
  from public.providers p
  where p.status = 'active'
    and p.created_at >= now() - interval '7 days'
    and exists (
      select 1 from public.activities a
      where a.provider_id = p.id and a.is_published
    );

  if v_count = 0 then
    return;
  end if;

  insert into public.notifications (user_id, type, title, body, data)
  select id, 'providers_added', 'We''ve added more vendors!',
    v_count || ' new vendor' || case when v_count = 1 then '' else 's' end || ' just joined BabyBrain.',
    jsonb_build_object('url', '/explore')
  from public.parent_profiles;
end;
$$;

select cron.unschedule(jobid) from cron.job where jobname = 'providers-added-digest';
select cron.schedule('providers-added-digest', '0 1 * * 1', $$select public.send_providers_added_digest();$$);
