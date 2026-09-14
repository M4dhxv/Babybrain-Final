-- Wire up "upgrade_nudge" (nudge Free parents toward Plus). Previously
-- completely unwired — app/api/admin/email-flows/route.ts listed it as "Not
-- wired — candidate for a 'N days since signup, still Free' cron."
-- Email content already matched the spec exactly, no template change needed.
--
-- Spec: "Every 3rd month on the first Saturday" — read as calendar quarters
-- (Jan/Apr/Jul/Oct). pg_cron has no "1st Saturday of specific months"
-- primitive, so this runs every Saturday and no-ops unless today (Singapore
-- time) is both in the 1st-7th (the day range a month's FIRST occurrence of
-- any weekday is guaranteed to land in) and a quarter-start month
-- (month % 3 = 1 matches exactly {1, 4, 7, 10}).

create or replace function public.send_upgrade_nudges()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_day int := extract(day from (now() at time zone 'Asia/Singapore'));
  v_month int := extract(month from (now() at time zone 'Asia/Singapore'));
begin
  if v_day < 1 or v_day > 7 or (v_month % 3) <> 1 then
    return;
  end if;

  insert into public.notifications (user_id, type, title, body, data)
  select p.id, 'upgrade_nudge', 'We have more to offer!',
    'See what BabyBrain Plus unlocks.',
    jsonb_build_object('url', '/pricing')
  from public.parent_profiles p
  left join public.customer_subscriptions cs on cs.user_id = p.id
  where cs.user_id is null
     or cs.plan <> 'plus'
     or cs.status not in ('active', 'trialing');
end;
$$;

select cron.unschedule(jobid) from cron.job where jobname = 'upgrade-nudges';
select cron.schedule('upgrade-nudges', '0 1 * * 6', $$select public.send_upgrade_nudges();$$);
