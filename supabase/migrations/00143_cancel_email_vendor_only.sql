-- 00143_cancel_email_vendor_only.sql
--
-- Cancellation emails, per the email-flows spec:
--
--   * Only a VENDOR cancellation (bookings.cancelled_by is not null) emails
--     the parent. It is now the branded class_cancelled email for every vendor
--     cancellation — previously it only went out when a make-up token was
--     issued — and it names the child whose seat was cancelled.
--   * A parent self-cancel (or a system cancel such as a Stripe refund, which
--     leaves cancelled_by null) still leaves the in-app booking_cancelled
--     notice, but stamped email_status = 'skipped' so the webhook sends no
--     email.
--
-- Supersedes the child-naming branch of 00142 (that logic moves into the
-- vendor email; a parent cancelling their own seat gets no email at all).
-- compensate_cancelled_booking is 00127's, minus its class_cancelled insert
-- (now sent from notify_booking_cancelled, so it is not sent twice).
--
-- Idempotent.

begin;

create or replace function public.notify_booking_cancelled()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_title    text;
  v_provider text;
  v_mode     text;
  v_child    text;
  v_tail     text;
begin
  if new.status = 'cancelled'
     and old.status is distinct from 'cancelled'
     and new.user_id is not null then
    select a.title, p.business_name,
           coalesce(nullif(new.cancel_refund_mode, ''), a.cancellation_refund_mode, 'refund')
      into v_title, v_provider, v_mode
    from public.activity_sessions s
    join public.activities a on a.id = s.activity_id
    left join public.providers p on p.id = a.provider_id
    where s.id = new.session_id;

    -- Whose seat this was: the guest name for a guest seat, else the child's
    -- profile name (null for a booking with neither).
    v_child := coalesce(
      nullif(btrim(new.guest_name), ''),
      (select c.name from public.children c where c.id = new.child_id)
    );

    if new.cancelled_by is not null then
      -- Vendor cancelled: the branded class_cancelled email (lib/emails/render.ts),
      -- naming the child. This is the only cancellation that emails the parent.
      insert into public.notifications (user_id, type, title, body, data)
      values (
        new.user_id,
        'class_cancelled',
        'Unfortunately your class has been cancelled',
        'Unfortunately ' || coalesce(v_title, 'your class') ||
          case when v_child is not null then ' has been cancelled for ' || v_child else ' has been cancelled' end ||
          '. Any refund or make up token issuance follows the policy of ' ||
          coalesce(v_provider, 'the provider') || '.',
        jsonb_build_object(
          'activity_name', v_title,
          'provider_name', v_provider,
          'child_name', v_child,
          'url', '/profile?tab=bookings',
          'booking_id', new.id
        )
      );
    else
      -- Parent (or system) cancelled: in-app notice only, no email.
      v_tail := case when v_mode = 'none'
        then 'This class is non-refundable, so no credit or make-up token was issued.'
        else 'Any refund follows the provider''s policy.'
      end;
      insert into public.notifications (user_id, type, title, body, data, email_status)
      values (
        new.user_id,
        'booking_cancelled',
        'Booking cancelled',
        'Your booking for ' || coalesce(v_title, 'a class') || ' has been cancelled. ' || v_tail,
        jsonb_build_object('url', '/profile?tab=bookings', 'booking_id', new.id),
        'skipped'
      );
    end if;
  end if;
  return new;
end;
$$;

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
          'booking_id', new.id
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

notify pgrst, 'reload schema';

commit;
