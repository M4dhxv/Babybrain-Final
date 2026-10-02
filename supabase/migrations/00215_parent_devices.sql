-- 00215_parent_devices.sql
--
-- Which device a parent uses, and whether they use the installed app or the website.
--
-- The admin Parents page shows a Device filter and, in each parent's detail, the device(s) and
-- whether they use the app (installed to the home screen) or the web. Neither is knowable from the
-- server for an installed app: a home-screen install sends the same user agent as the browser, so
-- the parent app itself reports it (record_parent_device, called once on load while signed in).
--
-- History: the operating system is back-filled from Supabase's own login records (auth.sessions), so
-- parents who signed in before this shipped still show a device. App / web cannot be recovered that
-- way, so those rows carry surface 'unknown' until the parent next opens the app.
--
-- Only the service role (the admin API) can read the table; there are deliberately no RLS policies.
--
-- Idempotent.

begin;

create table if not exists public.parent_devices (
  user_id       uuid not null references auth.users (id) on delete cascade,
  os            text not null check (os in ('ios', 'android', 'macos', 'windows', 'chromeos', 'linux', 'other')),
  surface       text not null default 'unknown' check (surface in ('app', 'web', 'unknown')),
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  primary key (user_id, os, surface)
);

alter table public.parent_devices enable row level security;

comment on table public.parent_devices is
  'One row per (parent, operating system, app-or-web) they have used. Written by record_parent_device from the parent app; read by the admin Parents page via the service role.';

-- The parent app reports itself. auth.uid() is the caller, so a parent can only ever write their own
-- row; values are checked so a client cannot store anything but the known set. Re-reporting within
-- the hour only costs a no-op.
create or replace function public.record_parent_device(p_os text, p_surface text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if auth.uid() is null
     or p_os not in ('ios', 'android', 'macos', 'windows', 'chromeos', 'linux', 'other')
     or p_surface not in ('app', 'web') then
    return;
  end if;

  insert into public.parent_devices (user_id, os, surface)
  values (auth.uid(), p_os, p_surface)
  on conflict (user_id, os, surface) do update
     set last_seen_at = now()
   where public.parent_devices.last_seen_at < now() - interval '1 hour';
end;
$$;

revoke all on function public.record_parent_device(text, text) from public, anon;
grant execute on function public.record_parent_device(text, text) to authenticated;

-- History from the login records.
insert into public.parent_devices (user_id, os, surface, first_seen_at, last_seen_at)
select s.user_id,
       case when s.user_agent ~* 'iphone|ipad|ipod' then 'ios'
            when s.user_agent ~* 'android'          then 'android'
            when s.user_agent ~* 'macintosh|mac os' then 'macos'
            when s.user_agent ~* 'windows'          then 'windows'
            when s.user_agent ~* 'cros'             then 'chromeos'
            when s.user_agent ~* 'linux'            then 'linux'
            else 'other' end as os,
       'unknown',
       min(s.created_at),
       max(coalesce(s.refreshed_at, s.updated_at, s.created_at))
  from auth.sessions s
 where s.user_agent ~* 'mozilla'         -- real browsers only; scripts (node, curl) are not devices
 group by 1, 2
on conflict (user_id, os, surface) do nothing;

commit;
