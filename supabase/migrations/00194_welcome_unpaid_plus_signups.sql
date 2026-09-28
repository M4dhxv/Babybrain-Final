-- 00194_welcome_unpaid_plus_signups.sql
--
-- A parent who picks Plus at sign-up is deliberately not sent the Free welcome
-- (00186): they get the Plus welcome once payment lands. But a parent who
-- picked Plus and then never paid got no welcome at all. Founder request
-- (guide review, 28 Sep): one welcome once the plan is settled, Free or Plus.
--
-- This hourly job sends the ordinary Free welcome to anyone who confirmed
-- their email at least 24 hours ago, chose Plus, still has no paid Plus plan,
-- and has had no welcome of either kind. 24 hours leaves room for a slow
-- checkout. The partial unique index from 00186 makes a second welcome
-- impossible.
--
-- New sign-ups only: confirmations before 29 Sep 2026 (SGT) are never picked
-- up, so the parents who were already in this state are not emailed
-- (decided 29 Sep).
--
-- Idempotent.

create or replace function public.send_unpaid_plus_welcomes()
returns int
language plpgsql
security definer set search_path = public
as $$
declare
  v_n int;
begin
  insert into public.notifications (user_id, type, title, body, data)
  select u.id, 'welcome', 'Welcome to BabyBrain!',
         'Tell us about your child to get personalised activity recommendations.',
         '{"url": "/onboarding"}'::jsonb
    from auth.users u
   where u.raw_user_meta_data ->> 'intended_plan' = 'plus'
     and coalesce(u.raw_user_meta_data ->> 'account_kind', '') <> 'vendor'
     and u.email_confirmed_at is not null
     and u.email_confirmed_at >= '2026-09-29 00:00+08'
     and u.email_confirmed_at <= now() - interval '24 hours'
     and not exists (
       select 1 from public.customer_subscriptions cs
        where cs.user_id = u.id
          and cs.plan = 'plus'
          and cs.status in ('active', 'trialing'))
     and not exists (
       select 1 from public.notifications n
        where n.user_id = u.id
          and n.type in ('welcome', 'parent_welcome_paid'))
  on conflict (user_id) where type = 'welcome' do nothing;

  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public.send_unpaid_plus_welcomes() from public, anon, authenticated;

select cron.unschedule(jobid) from cron.job where jobname = 'unpaid-plus-welcomes';
select cron.schedule('unpaid-plus-welcomes', '20 * * * *', $$select public.send_unpaid_plus_welcomes();$$);
