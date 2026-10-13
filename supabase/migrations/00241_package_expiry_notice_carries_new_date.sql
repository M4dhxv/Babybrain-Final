-- 00241_package_expiry_notice_carries_new_date.sql
--
-- The "package validity updated" email did not say the new date: the email
-- template prints data.expires_on ("It is now valid until ..."), which the
-- make-up token notice has carried since 00225, but provider_set_purchase_expiry
-- only put the date in the in-app body text. It now sets expires_on too, in the
-- same Singapore-time format. Otherwise identical to the 00192 definition
-- (manage-role check included). Idempotent (create or replace).

CREATE OR REPLACE FUNCTION public.provider_set_purchase_expiry(p_purchase uuid, p_expires_at timestamp with time zone)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_provider uuid;
  v_status text;
  v_remaining int;
  v_user_id uuid;
  v_package_name text;
  v_provider_name text;
begin
  select provider_id, status, credits_remaining
    into v_provider, v_status, v_remaining
    from public.package_purchases
   where id = p_purchase;

  if v_provider is null or v_provider not in (select public.user_manage_provider_ids()) then
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

  select pp.user_id, pk.name, pr.business_name
    into v_user_id, v_package_name, v_provider_name
  from public.package_purchases pp
  join public.packages pk on pk.id = pp.package_id
  join public.providers pr on pr.id = pp.provider_id
  where pp.id = p_purchase;

  if v_user_id is not null then
    insert into public.notifications (user_id, type, title, body, data)
    values (
      v_user_id,
      'package_expiry_changed',
      'Package validity updated',
      coalesce(v_provider_name, 'Your provider') || ' updated the validity of your ' ||
        coalesce(v_package_name, 'package') ||
        (case when p_expires_at is not null
              then ' — now valid until ' || to_char(p_expires_at at time zone 'Asia/Singapore', 'FMDD FMMonth YYYY') || '.'
              else ' — it no longer expires.' end),
      jsonb_build_object(
        'url', '/profile?tab=packages',
        'package_purchase_id', p_purchase,
        'provider_name', v_provider_name,
        'expires_on', case when p_expires_at is not null
                        then to_char(p_expires_at at time zone 'Asia/Singapore', 'FMDD FMMonth YYYY') end
      )
    );
  end if;
end;
$function$;

notify pgrst, 'reload schema';
