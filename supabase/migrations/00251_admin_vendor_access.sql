-- 00251_admin_vendor_access.sql
--
-- Lets a Babybrain admin open any vendor's portal and work in it as a manager,
-- instead of every vendor tool having to be rebuilt inside the admin portal.
--
--  * admin_vendor_access: one row per (admin account, vendor). Written only by
--    the server (POST /api/admin/providers/[id]/portal-access, which checks
--    ADMIN_EMAILS first); no expiry — once granted, the admin can come back to
--    that vendor any time.
--  * The two RLS helpers that every vendor table policy and vendor RPC use,
--    user_provider_ids() and user_manage_provider_ids(), now also return those
--    vendors. So the admin sees and edits exactly what one of the vendor's
--    managers can, with no other policy or RPC changing.
--  * user_owner_provider_ids() is NOT widened: owner-only things (billing, the
--    team, ownership) stay with the vendor.
--  * The admin is deliberately NOT a provider_members row: booking emails,
--    push notifications, chat channels, the vendor's Team list and seat counts
--    all read provider_members, so none of them pick the admin up.
--
-- Compatibility with the deployed apps (see 00247): the helpers keep their
-- signatures and return the same rows for everyone without a grant, so the
-- live portal and parent app behave exactly as before.

create table if not exists public.admin_vendor_access (
  user_id     uuid not null references auth.users (id) on delete cascade,
  provider_id uuid not null references public.providers (id) on delete cascade,
  granted_by  text,
  created_at  timestamptz not null default now(),
  last_opened_at timestamptz not null default now(),
  primary key (user_id, provider_id)
);

create index if not exists admin_vendor_access_provider_idx on public.admin_vendor_access (provider_id);

alter table public.admin_vendor_access enable row level security;

-- An admin can see their own grants (the vendor portal reads them to know which
-- business to open). Nobody can write them from the client.
drop policy if exists admin_vendor_access_select_own on public.admin_vendor_access;
create policy admin_vendor_access_select_own on public.admin_vendor_access
  for select to authenticated using (user_id = auth.uid());

revoke all on public.admin_vendor_access from anon;
revoke insert, update, delete on public.admin_vendor_access from authenticated;
grant select on public.admin_vendor_access to authenticated;

create or replace function public.user_provider_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select provider_id from public.provider_members
  where user_id = auth.uid() and status = 'active'
  union
  select provider_id from public.admin_vendor_access
  where user_id = auth.uid();
$$;

create or replace function public.user_manage_provider_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select provider_id from public.provider_members
  where user_id = auth.uid() and status = 'active' and role in ('owner','manager')
  union
  select provider_id from public.admin_vendor_access
  where user_id = auth.uid();
$$;
