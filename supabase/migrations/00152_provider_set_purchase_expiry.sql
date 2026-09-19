-- Vendors can change the expiry on an individual package purchase (e.g. a
-- parent asks for more time and the vendor agrees). Mirrors the make-up token
-- expiry editor. package_purchases has no vendor UPDATE policy on purpose
-- (credits must only move through redeem_package_credit), so this narrow
-- SECURITY DEFINER function touches expires_at — and a stale 'expired' status —
-- and nothing else.

create or replace function public.provider_set_purchase_expiry(
  p_purchase uuid,
  p_expires_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_provider uuid;
  v_status text;
  v_remaining int;
begin
  select provider_id, status, credits_remaining
    into v_provider, v_status, v_remaining
    from public.package_purchases
   where id = p_purchase;

  if v_provider is null or v_provider not in (select public.user_provider_ids()) then
    raise exception 'not authorized';
  end if;

  if p_expires_at is not null and p_expires_at <= now() then
    raise exception 'Expiry must be in the future';
  end if;

  update public.package_purchases
     set expires_at = p_expires_at,
         status = case
                    when v_status = 'expired' and v_remaining > 0 then 'active'
                    else v_status
                  end
   where id = p_purchase;
end;
$$;
grant execute on function public.provider_set_purchase_expiry(uuid, timestamptz) to authenticated;
