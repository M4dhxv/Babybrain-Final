-- 00114_lock_provider_ownership_columns.sql
--
-- Defense-in-depth for the ownership model (follows 00113).
--
-- RLS policy "managers update provider" (00007) is row-scoped only —
-- `using / with check (id in user_manage_provider_ids())` — with no column
-- guard. So a *manager* (not just an owner) can run
--   update public.providers set owner_id = auth.uid() where id = <their provider>
-- and rewrite `owner_id` / `is_claimed`. Those columns underpin the claim
-- flow's takeover check (app/api/vendor/claim/verify: refuse if
-- providers.owner_id is set and isn't the caller), so a manager could weaken
-- that guard from the client.
--
-- `owner_id` and `is_claimed` are only ever meant to move through the claim
-- API (service role, no auth.uid()) or a migration. This trigger enforces
-- that: a change to either column from a normal signed-in session is allowed
-- only if that session is an active OWNER of the row.

begin;

create or replace function public.providers_guard_ownership_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.owner_id is distinct from old.owner_id
     or coalesce(new.is_claimed, false) is distinct from coalesce(old.is_claimed, false)
  then
    -- Service role / SQL console / SECURITY DEFINER server code has no
    -- auth.uid() — that path is trusted (it's the claim API).
    if auth.uid() is null then
      return new;
    end if;
    -- A signed-in caller may only move these columns on a provider they
    -- actively own.
    if not exists (
      select 1 from public.provider_members
      where provider_id = old.id
        and user_id = auth.uid()
        and status = 'active'
        and role = 'owner'
    ) then
      raise exception
        'only an owner may change owner_id / is_claimed on provider %', old.id
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists providers_guard_ownership on public.providers;
create trigger providers_guard_ownership
  before update on public.providers
  for each row execute function public.providers_guard_ownership_columns();

commit;
