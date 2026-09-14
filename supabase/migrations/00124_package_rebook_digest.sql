-- Wire up "package_rebook" (nudge to re-buy after a package expires).
-- Previously completely unwired — app/api/admin/email-flows/route.ts listed
-- it as "Not wired to anything yet." Email content already matched the spec
-- exactly, no template change needed.
--
-- Spec: "customers who have a package which has expired, sent the day after
-- expiry" — a daily cron matching package_purchases.expires_at's Singapore
-- calendar date against yesterday, not a credits-exhausted check (a package
-- fully used before its expiry date is already status='used' and excluded
-- by the status='active' filter here).
--
-- Also flips status to 'expired' for those rows while it's at it — nothing
-- else in the codebase ever sets that value (confirmed: every other write
-- path only checks expires_at live), so the column was declared but never
-- actually reached that state.

create or replace function public.send_package_rebook_nudges()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_yesterday date := (now() at time zone 'Asia/Singapore')::date - 1;
begin
  insert into public.notifications (user_id, type, title, body, data)
  select pp.user_id, 'package_rebook', 'Would you like to re-book your package?',
    'Your package with ' || pr.business_name || ' has expired.',
    jsonb_build_object(
      'provider_name', pr.business_name,
      'url', case when a.slug is not null then '/activity?slug=' || a.slug else '/explore' end
    )
  from public.package_purchases pp
  join public.packages pk on pk.id = pp.package_id
  join public.providers pr on pr.id = pp.provider_id
  left join public.activities a on a.id = pk.activity_id
  where pp.status = 'active'
    and pp.expires_at is not null
    and (pp.expires_at at time zone 'Asia/Singapore')::date = v_yesterday;

  update public.package_purchases
  set status = 'expired'
  where status = 'active'
    and expires_at is not null
    and (expires_at at time zone 'Asia/Singapore')::date = v_yesterday;
end;
$$;

select cron.unschedule(jobid) from cron.job where jobname = 'package-rebook-nudges';
select cron.schedule('package-rebook-nudges', '0 1 * * *', $$select public.send_package_rebook_nudges();$$);
