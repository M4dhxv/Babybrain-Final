-- 00205_compensation_for_removed_activities.sql
--
-- What a cancelled booking is given back (compensate_cancelled_booking, last
-- defined in 00170) assumed the activity it was for still exists. When a Wix
-- service is removed (00203) or the vendor unlinks it, the activity goes
-- unpublished, and two things broke:
--
--   1. Dead links. The make-up token / returned token / returned pack-credit
--      notice (and the email built from it) deep-linked to
--      /book?slug=<that activity>, which is now a dead page. A make-up token is
--      tied to the PROVIDER (make_up_tokens has no activity), so it is still
--      usable on the provider's other classes; only the link was wrong. When the
--      activity is no longer live the link now goes to the parent's wallet
--      (/profile?tab=makeup) or packages page (/profile?tab=packages).
--
--   2. A pack credit returned to a pack that can no longer be used. A pack can
--      be limited to specific activities (packages.activity_ids). If every
--      activity it is limited to is gone, the returned credit could never be
--      redeemed. That case now issues a make-up token (usable on any class from
--      the provider) instead, exactly as an expired pack already does.
--
-- Everything else is unchanged from 00170: nothing is given back under a
-- 'none' cancel mode, a booking bought with a token gets that token back, an
-- unexpired unrestricted pack gets its credit back, and a paid booking gets a
-- token. "Live" = published, not archived, not flagged missing on Wix, not
-- removed by the vendor.
--
-- Idempotent. ASCII only.

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
  v_allowed        uuid[];
  v_activity_title text;
  v_activity_slug  text;
  v_activity_live  boolean;
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
         coalesce(nullif(new.cancel_refund_mode, ''), a.cancellation_refund_mode, 'refund'),
         (a.is_published and a.archived_at is null
            and a.wix_missing_since is null and a.wix_removed_at is null)
    into v_activity_title, v_activity_slug, v_provider_name, v_mode, v_activity_live
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  join public.providers   p on p.id = new.provider_id
  where s.id = new.session_id;

  -- A dead activity has no booking page: never deep-link to it.
  if not coalesce(v_activity_live, false) then
    v_activity_slug := null;
  end if;

  -- Provider withholds compensation for this class: nothing goes back - not a
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
        ' is back - use it on another class.',
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

    -- A pack limited to specific activities is only worth a credit while at
    -- least one of them is still live; otherwise the credit could never be
    -- redeemed, so fall through to a make-up token.
    if v_pack_usable then
      select pk.activity_ids into v_allowed
      from public.packages pk where pk.id = v_pur.package_id;
      if v_allowed is not null and array_length(v_allowed, 1) > 0 then
        v_pack_usable := exists (
          select 1 from public.activities x
          where x.id = any (v_allowed)
            and x.is_published and x.archived_at is null
            and x.wix_missing_since is null and x.wix_removed_at is null
        );
      end if;
    end if;

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
          -- Lets the Notifications tab deep-link straight to (and highlight)
          -- this specific package on /profile?tab=packages.
          'package_purchase_id', v_pur.id
        )
      );
      return new;
    end if;
    -- pack expired, or limited to activities that are all gone: the credit is
    -- dead weight, fall through to a token
  else
    -- No credit was spent, so only a paid booking earns compensation.
    if new.payment_status <> 'paid' then
      return new;
    end if;
  end if;

  -- ---- Path 2: issue a make-up token ---------------------------------
  -- (paid cash booking, or a package booking whose pack cannot be used)
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
      ' has been replaced with a make-up token - use it on another ' ||
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

  -- The vendor-cancelled "class_cancelled" email is sent by
  -- notify_booking_cancelled for every vendor cancellation, so it is
  -- deliberately not repeated here.
  return new;
end;
$$;

revoke all on function public.compensate_cancelled_booking() from public, anon, authenticated;
