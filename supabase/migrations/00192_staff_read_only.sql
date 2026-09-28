-- 00192_staff_read_only.sql
--
-- Founder request (guide review 28 Sep): the "staff" team role is read-only.
-- Staff cannot issue make-up tokens or change activities, schedules or
-- packages. Owners and managers keep full control.
--
-- The vendor portal already hid these buttons from staff, but the database
-- still let a staff login do them directly:
--
--   packages          "members manage packages" (ALL, any team member)
--   make_up_tokens    "members manage tokens"   (ALL, any team member)
--   vendor_cancel_session()          cancel a whole session
--   provider_set_purchase_expiry()   change a parent's pack expiry
--
-- Each is now owner/manager only (user_manage_provider_ids). Staff can still
-- READ packages, purchases and tokens, and can still mark attendance and
-- message parents (attendance / chat are untouched). Activities, sessions,
-- policies and bookings were already manager-only.
--
-- No live login has the staff role today (24 owners, 6 managers), so this
-- changes nothing for anyone currently using the portal.
--
-- Idempotent.

begin;

-- packages: team members read everything (the existing "read active packages"
-- policy already covers staff); only managers write.
drop policy if exists "members manage packages" on public.packages;
drop policy if exists "managers manage packages" on public.packages;
create policy "managers manage packages" on public.packages
  for all
  using (provider_id in (select public.user_manage_provider_ids()))
  with check (provider_id in (select public.user_manage_provider_ids()));

-- make_up_tokens: staff keep read access, managers write.
drop policy if exists "members manage tokens" on public.make_up_tokens;
drop policy if exists "members read tokens" on public.make_up_tokens;
drop policy if exists "managers manage tokens" on public.make_up_tokens;
create policy "members read tokens" on public.make_up_tokens
  for select
  using (provider_id in (select public.user_provider_ids()));
create policy "managers manage tokens" on public.make_up_tokens
  for all
  using (provider_id in (select public.user_manage_provider_ids()))
  with check (provider_id in (select public.user_manage_provider_ids()));

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
        'provider_name', v_provider_name
      )
    );
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION public.vendor_cancel_session(p_session_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_provider uuid;
  v_status   text;
  v_waitlist integer := 0;
  v_live     integer := 0;
begin
  select a.provider_id, s.status into v_provider, v_status
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  where s.id = p_session_id
  for update of s;

  if not found then
    raise exception 'Session not found';
  end if;

  if v_provider not in (select public.user_manage_provider_ids()) then
    raise exception 'not authorized';
  end if;

  if v_status = 'cancelled' then
    return 0;
  end if;

  update public.activity_sessions set status = 'cancelled' where id = p_session_id;

  update public.bookings
     set status = 'cancelled',
         cancel_refund_mode = 'refund',
         cancel_reason = 'Class cancelled by the provider',
         cancelled_by = auth.uid()
   where session_id = p_session_id and status = 'waitlisted';
  get diagnostics v_waitlist = row_count;

  update public.bookings
     set status = 'cancelled',
         cancel_refund_mode = 'refund',
         cancel_reason = 'Class cancelled by the provider',
         cancelled_by = auth.uid()
   where session_id = p_session_id and status in ('pending', 'confirmed');
  get diagnostics v_live = row_count;

  return v_waitlist + v_live;
end;
$function$;

commit;
