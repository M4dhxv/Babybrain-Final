-- 00201_lock_provider_stripe_columns.sql
--
-- providers.payouts_enabled and providers.stripe_account_id say whether a vendor
-- has a live Stripe Connect account. Checkout sends the parent's money straight
-- to that account when both are set, and the vendor portal refuses to publish a
-- class without payouts. Both are meant to be written only by the server:
-- Stripe's webhook, the "Connect payouts" API, and the admin tools.
--
-- But RLS policy "managers update provider" (00007) is row-scoped only, and the
-- vendor portal talks to the database directly as the signed-in vendor. So a
-- vendor (or any staff member with manager rights) could run
--   update public.providers set payouts_enabled = true where id = <their id>
-- and switch the Stripe check off for themselves, or point stripe_account_id at
-- an account of their choosing. 00114 guarded owner_id / is_claimed the same way
-- but never covered these two.
--
-- This refuses any change to either column from a signed-in session, on update
-- and on insert. The server paths all use the service role (no auth.uid()) and
-- are unaffected: app/api/vendor/stripe/connect, app/api/webhooks/stripe,
-- lib/stripe-connect. The vendor portal's own provider updates (business
-- details, listing edits) never touch these columns.
--
-- Own trigger, like 00200, so 00114's behaviour is untouched. Idempotent.

begin;

create or replace function public.providers_guard_stripe_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Service role / SQL console / migrations have no auth.uid(): trusted.
  if auth.uid() is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if coalesce(new.payouts_enabled, false) or new.stripe_account_id is not null then
      raise exception 'payouts_enabled / stripe_account_id are set by the server, not by a signed-in user'
        using errcode = 'insufficient_privilege';
    end if;
  elsif new.payouts_enabled is distinct from old.payouts_enabled
     or new.stripe_account_id is distinct from old.stripe_account_id then
    raise exception 'payouts_enabled / stripe_account_id on provider % are set by the server, not by a signed-in user', old.id
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

drop trigger if exists providers_guard_stripe_columns on public.providers;
create trigger providers_guard_stripe_columns
  before insert or update on public.providers
  for each row execute function public.providers_guard_stripe_columns();

notify pgrst, 'reload schema';

commit;
