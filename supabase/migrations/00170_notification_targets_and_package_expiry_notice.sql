-- Two gaps found while wiring the Notifications tab to actually link/highlight
-- the thing each notification is about (parent app):
--
-- 1. 'package_credit_returned' (compensate_cancelled_booking, latest version
--    in 00143_cancel_email_vendor_only.sql) links to /profile?tab=packages
--    but never says *which* package purchase to highlight there — every other
--    booking/token notification already carries booking_id/token_id for this,
--    this one was the odd one out. Same insert, plus package_purchase_id.
--
-- 2. provider_set_purchase_expiry (00152) lets a vendor change the expiry on
--    a parent's package purchase but never told the parent it happened — the
--    only vendor-initiated write to package_purchases (besides redemption,
--    which the parent does themselves) that sent nothing at all.

begin;

create or replace function public.compensate_cancelled_booking()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_pur            public.package_purchases;
  v_tok            public.make_up_tokens;
  v_pack_usable    boolean := false;
  v_activity_title text;
  v_activity_slug  text;
  v_provider_name  text;
  v_mode           text;
  v_token_id       uuid;
begin
  -- Only the transition INTO cancelled, once.
  if new.status <> 'cancelled' or old.status is not distinct from 'cancelled' then
    return new;
  end if;

  -- Nobody to compensate: a manual / guest booking has no parent account,
  -- and provider_id is always stamped on a real booking.
  if new.user_id is null or new.provider_id is null then
    return new;
  end if;

  -- The cash was already returned on this same update (refundBooking / the
  -- charge.refunded webhook both set payment_status = 'refunded' here).
  if new.payment_status = 'refunded' then
    return new;
  end if;

  select a.title, a.slug, p.business_name,
         coalesce(nullif(new.cancel_refund_mode, ''), a.cancellation_refund_mode, 'refund')
    into v_activity_title, v_activity_slug, v_provider_name, v_mode
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  join public.providers   p on p.id = new.provider_id
  where s.id = new.session_id;

  -- Provider withholds compensation for this class: nothing goes back — not a
  -- reinstated credit, not a released token, not a fresh make-up token. An
  -- expired pack / lapsed token is simply left as-is.
  if v_mode = 'none' then
    return new;
  end if;

  -- ---- Path 0: this booking was made by redeeming a make-up token -----
  select * into v_tok
  from public.make_up_tokens
  where redeemed_booking_id = new.id
    and status = 'redeemed'
  for update;
  if found then
    update public.make_up_tokens
    set status = 'issued',
        redeemed_booking_id = null,
        -- If it had already lapsed, give it a fresh 30-day window so the
        -- returned token isn't dead on arrival.
        expires_at = case
          when expires_at is not null and expires_at <= now()
            then now() + interval '30 days'
          else expires_at
        end
    where id = v_tok.id;

    insert into public.notifications (user_id, type, title, body, data)
    values (
      new.user_id,
      'make_up_token_returned',
      'Make-up token available again',
      'Your make-up token for ' || coalesce(v_provider_name, 'the provider') ||
        ' is back — use it on another class.',
      jsonb_build_object(
        'activity_name', v_activity_title,
        'provider_name', v_provider_name,
        'url', case when v_activity_slug is not null
                 then '/book?slug=' || v_activity_slug || '&token=' || v_tok.id
                 else '/profile?tab=makeup' end,
        'token_id', v_tok.id,
        'booking_id', new.id
      )
    );
    return new;
  end if;

  -- ---- Path 1: booked against a package credit ------------------------
  if new.package_purchase_id is not null then
    select * into v_pur
    from public.package_purchases
    where id = new.package_purchase_id
    for update;
    if not found then
      return new;  -- shouldn't happen (FK is ON DELETE SET NULL); be safe
    end if;

    v_pack_usable := v_pur.status <> 'expired'
                     and (v_pur.expires_at is null or v_pur.expires_at > now());

    if v_pack_usable then
      update public.package_purchases
      set credits_remaining = credits_remaining + 1,
          status = case when status = 'used' then 'active' else status end
      where id = v_pur.id;

      insert into public.notifications (user_id, type, title, body, data)
      values (
        new.user_id,
        'package_credit_returned',
        'Package credit returned',
        'Your credit for ' || coalesce(v_activity_title, 'a class') ||
          ' is back on your ' || coalesce(v_provider_name, 'provider') || ' package.',
        jsonb_build_object(
          'activity_name', v_activity_title,
          'provider_name', v_provider_name,
          'url', case when v_activity_slug is not null
                   then '/book?slug=' || v_activity_slug
                   else '/profile?tab=packages' end,
          'booking_id', new.id,
          -- New: lets the Notifications tab deep-link straight to (and
          -- highlight) this specific package on /profile?tab=packages,
          -- instead of just landing on the tab.
          'package_purchase_id', v_pur.id
        )
      );
      return new;
    end if;
    -- pack has expired: the credit is dead weight, fall through to a token
  else
    -- No credit was spent, so only a paid booking earns compensation.
    if new.payment_status <> 'paid' then
      return new;
    end if;
  end if;

  -- ---- Path 2: issue a make-up token ---------------------------------
  -- (paid cash booking, or a package booking whose pack has expired)
  if exists (select 1 from public.make_up_tokens where origin_booking_id = new.id) then
    return new;  -- already compensated for this booking
  end if;

  insert into public.make_up_tokens
    (provider_id, user_id, child_id, origin_booking_id, status, issued_by, expires_at, auto_issued)
  values
    (new.provider_id, new.user_id, new.child_id, new.id, 'issued', null, null, true)
  returning id into v_token_id;

  insert into public.notifications (user_id, type, title, body, data)
  values (
    new.user_id,
    'make_up_token_issued',
    'Make-up token issued',
    'Your cancelled booking for ' || coalesce(v_activity_title, 'a class') ||
      ' has been replaced with a make-up token — use it on another ' ||
      coalesce(v_provider_name, 'provider') || ' class. It doesn''t expire.',
    jsonb_build_object(
      'activity_name', v_activity_title,
      'provider_name', v_provider_name,
      'url', case when v_activity_slug is not null
               then '/book?slug=' || v_activity_slug || '&token=' || v_token_id
               else '/profile?tab=makeup' end,
      'token_id', v_token_id,
      'booking_id', new.id
    )
  );

  -- The vendor-cancelled "class_cancelled" email is now sent by
  -- notify_booking_cancelled for every vendor cancellation (not only when a
  -- make-up token is issued here), so it is deliberately not repeated.
  return new;
end;
$$;

-- Vendor changed a package purchase's expiry (extended it, most often, per
-- the comment on the original function) — tell the parent, with enough to
-- deep-link straight to that package and highlight it.
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
  v_user_id uuid;
  v_package_name text;
  v_provider_name text;
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
$$;
grant execute on function public.provider_set_purchase_expiry(uuid, timestamptz) to authenticated;

notify pgrst, 'reload schema';

commit;
