-- Wire up "package_token_reminder" (nudge parents with unused passes /
-- make-up tokens). Previously completely unwired — see
-- app/api/admin/email-flows/route.ts, listed as "Not wired to anything yet."
-- Email content already matched the spec exactly, no template change needed.
--
-- Spec: "For customers with passes and make-up tokens to use, send on the
-- second Wednesday of every month." pg_cron has no "nth weekday of month"
-- primitive, so this runs every Wednesday and short-circuits unless today
-- (Singapore time) falls on the 8th-14th — the day range every weekday's
-- SECOND occurrence in a month is guaranteed to land in, since its first
-- occurrence must fall in the 1st-7th.
--
-- "Active" mirrors the stricter definition the booking page itself uses
-- (frontends/parent/src/pages/dashboard.tsx ~3210) rather than the looser
-- My-Passes-tab helper that doesn't re-check expiry:
--   package_purchases: status = 'active' and credits_remaining > 0
--     and (expires_at is null or expires_at > now())
--   make_up_tokens: status = 'issued'
--     and (expires_at is null or expires_at > now())

create or replace function public.send_package_token_reminders()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_day int := extract(day from (now() at time zone 'Asia/Singapore'));
begin
  if v_day < 8 or v_day > 14 then
    return;
  end if;

  insert into public.notifications (user_id, type, title, body, data)
  select distinct t.user_id,
    'package_token_reminder',
    'Don''t forget you have passes to use',
    'You have active passes or make-up tokens ready to redeem.',
    jsonb_build_object('url', '/profile')
  from (
    select user_id from public.package_purchases
    where status = 'active' and credits_remaining > 0
      and (expires_at is null or expires_at > now())
    union
    select user_id from public.make_up_tokens
    where user_id is not null and status = 'issued'
      and (expires_at is null or expires_at > now())
  ) t;
end;
$$;

select cron.unschedule(jobid) from cron.job where jobname = 'package-token-reminders';
select cron.schedule('package-token-reminders', '0 1 * * 3', $$select public.send_package_token_reminders();$$);
