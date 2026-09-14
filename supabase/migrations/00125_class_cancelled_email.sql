-- Wire up "class_cancelled" (email-flows spec: "A vendor cancels a class
-- with customers booked on it and issues a make up token"). This is
-- narrower than the existing generic booking_cancelled notification, which
-- fires for ANY cancellation (including a parent cancelling their own
-- booking via cancel_booking) — this one only fires when:
--   1. the cancellation was vendor-initiated (bookings.cancelled_by is not
--      null — null means a parent self-cancel, per 00099's own comment on
--      that column), and
--   2. it results in a make-up token actually being issued (Path 2 of
--      compensate_cancelled_booking).
--
-- Body is 00099's compensate_cancelled_booking with exactly one addition:
-- a second notification insert right after the existing make_up_token_issued
-- one, gated on cancelled_by.

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

  select a.title, p.business_name,
         coalesce(nullif(new.cancel_refund_mode, ''), a.cancellation_refund_mode, 'refund')
    into v_activity_title, v_provider_name, v_mode
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
      jsonb_build_object('url', '/profile?tab=makeup', 'token_id', v_tok.id, 'booking_id', new.id)
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
        jsonb_build_object('url', '/profile?tab=packages', 'booking_id', new.id)
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
    jsonb_build_object('url', '/profile?tab=makeup', 'token_id', v_token_id, 'booking_id', new.id)
  );

  -- New: the email-flows spec's "your class has been cancelled" — only when
  -- the vendor (not the parent) was the one who cancelled it.
  if new.cancelled_by is not null then
    insert into public.notifications (user_id, type, title, body, data)
    values (
      new.user_id,
      'class_cancelled',
      'Unfortunately your class has been cancelled',
      'Unfortunately ' || coalesce(v_activity_title, 'your class') ||
        ' has been cancelled. Any refund or make up token issuance follows the policy of ' ||
        coalesce(v_provider_name, 'the provider') || '.',
      jsonb_build_object(
        'activity_name', v_activity_title,
        'provider_name', v_provider_name,
        'url', '/profile?tab=bookings',
        'booking_id', new.id
      )
    );
  end if;

  return new;
end;
$$;
