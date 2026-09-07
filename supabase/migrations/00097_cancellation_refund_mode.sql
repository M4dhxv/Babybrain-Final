-- 00097_cancellation_refund_mode.sql
--
-- Let a provider decide what a cancellation gives back: the parent made whole
-- the usual way (a package credit reinstated, a redeemed make-up token
-- released, or a fresh make-up token for a cash booking), or nothing at all —
-- "payment for this activity is non-refundable, if cancelled".
--
-- Two layers:
--
--   * activities.cancellation_refund_mode — the class default, shown next to
--     the "Allow cancellations" toggle. Only meaningful while
--     allow_cancellation is true: if parents can't self-cancel there is no
--     refund to promise or withhold, and a vendor cancelling a single booking
--     picks the mode for that one booking in the dialog. 'refund' (the
--     default) keeps every pre-00097 booking behaving exactly as before.
--
--   * bookings.cancel_refund_mode — the decision actually applied to one
--     cancelled row. cancel_booking / cancel_booking_group stamp it from the
--     activity default; the vendor's per-booking cancel stamps whatever they
--     chose. compensate_cancelled_booking (00080/00081) now reads THIS,
--     falling back to the activity default and then to 'refund' for any row
--     an older client cancelled by setting status alone.
--
-- bookings.cancel_reason / cancelled_by record why a vendor withheld a
-- refund. A blank reason on a vendor-initiated 'none' cancel is rejected; the
-- parent's own cancel_booking path leaves cancelled_by null and is never
-- caught by that check (a parent 'none' cancel is governed by the policy they
-- accepted at checkout, not by a typed-in reason).

begin;

-- =============================================================
-- Columns
-- =============================================================
alter table public.activities
  add column if not exists cancellation_refund_mode text not null default 'refund'
    check (cancellation_refund_mode in ('refund', 'none'));

comment on column public.activities.cancellation_refund_mode is
  'What a cancellation returns for this class: ''refund'' = reinstate the '
  'package credit / release or issue a make-up token (compensate_cancelled_'
  'booking); ''none'' = nothing, "non-refundable if cancelled". Only takes '
  'effect while allow_cancellation is true.';

alter table public.bookings
  add column if not exists cancel_refund_mode text
    check (cancel_refund_mode in ('refund', 'none')),
  add column if not exists cancel_reason text,
  add column if not exists cancelled_by uuid;

comment on column public.bookings.cancel_refund_mode is
  'The refund decision applied when this booking was cancelled. Stamped by '
  'cancel_booking / cancel_booking_group from the activity default, or by the '
  'vendor''s per-booking cancel. compensate_cancelled_booking reads it; null '
  'means "fall back to the activity default, then ''refund''".';
comment on column public.bookings.cancelled_by is
  'The vendor user who cancelled this booking from the portal. Null for a '
  'parent self-cancel (cancel_booking / cancel_booking_group).';

-- =============================================================
-- A vendor withholding a refund has to say why
-- =============================================================
create or replace function public.require_reason_for_no_refund_cancel()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'cancelled'
     and old.status is distinct from 'cancelled'
     and new.cancel_refund_mode = 'none'
     and new.cancelled_by is not null
     and coalesce(btrim(new.cancel_reason), '') = '' then
    raise exception 'A reason is required when cancelling with no refund.';
  end if;
  return new;
end;
$$;

drop trigger if exists before_booking_cancel_require_reason on public.bookings;
create trigger before_booking_cancel_require_reason
  before update of status on public.bookings
  for each row execute function public.require_reason_for_no_refund_cancel();

-- =============================================================
-- Compensation on cancellation — now mode-aware
-- =============================================================
-- Body is 00081's, with one addition: resolve the effective refund mode from
-- the booking, then the activity, then 'refund'; when it is 'none', return
-- without reinstating a credit, releasing a redeemed token, or minting a
-- make-up token. The parent accepted this at checkout; a vendor 'none' cancel
-- also carries a recorded reason. Every expiry fallback below is unchanged and
-- only runs on the 'refund' path.
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

  return new;
end;
$$;

-- =============================================================
-- Tell the parent plainly when nothing came back
-- =============================================================
create or replace function public.notify_booking_cancelled()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_title text;
  v_mode  text;
begin
  if new.status = 'cancelled'
     and old.status is distinct from 'cancelled'
     and new.user_id is not null then
    select a.title,
           coalesce(nullif(new.cancel_refund_mode, ''), a.cancellation_refund_mode, 'refund')
      into v_title, v_mode
    from public.activity_sessions s
    join public.activities a on a.id = s.activity_id
    where s.id = new.session_id;

    insert into public.notifications (user_id, type, title, body, data)
    values (
      new.user_id,
      'booking_cancelled',
      'Booking cancelled',
      'Your booking for ' || coalesce(v_title, 'a class') || ' has been cancelled. ' ||
        case when v_mode = 'none'
          then 'This class is non-refundable, so no credit or make-up token was issued.'
          else 'Any refund follows the provider''s policy.'
        end,
      jsonb_build_object('url', '/profile?tab=bookings', 'booking_id', new.id)
    );
  end if;
  return new;
end;
$$;

-- =============================================================
-- Parent-facing cancel RPCs — stamp the mode from the class default
-- =============================================================
create or replace function public.cancel_booking(p_booking_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_user uuid := auth.uid();
  v_bk public.bookings;
  v_allow boolean;
  v_cutoff integer;
  v_starts timestamptz;
  v_mode text;
begin
  if v_user is null then raise exception 'Not authenticated'; end if;

  select b.* into v_bk from public.bookings b
  where b.id = p_booking_id and b.user_id = v_user;
  if not found then raise exception 'Booking not found'; end if;
  if v_bk.status not in ('pending', 'confirmed', 'waitlisted') then
    raise exception 'This booking can no longer be cancelled.';
  end if;

  select a.allow_cancellation, a.cancellation_cutoff_hours, s.starts_at, a.cancellation_refund_mode
    into v_allow, v_cutoff, v_starts, v_mode
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  where s.id = v_bk.session_id;

  if not v_allow then
    raise exception 'The provider does not allow cancellations for this class.';
  end if;
  if v_starts - make_interval(hours => v_cutoff) < now() then
    raise exception 'The cancellation window for this class has closed (% hours before the session).', v_cutoff;
  end if;

  update public.bookings
  set status = 'cancelled',
      cancel_refund_mode = coalesce(v_mode, 'refund')
  where id = p_booking_id;
end;
$$;

create or replace function public.cancel_booking_group(p_group_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_user   uuid := auth.uid();
  v_allow  boolean;
  v_cutoff integer;
  v_starts timestamptz;
  v_session uuid;
  v_live   int;
  v_mode   text;
begin
  if v_user is null then raise exception 'Not authenticated'; end if;

  select count(*), min(b.session_id)
    into v_live, v_session
  from public.bookings b
  where b.booking_group_id = p_group_id
    and b.user_id = v_user
    and b.status in ('pending', 'confirmed', 'waitlisted');
  if coalesce(v_live, 0) = 0 then
    raise exception 'This booking can no longer be cancelled.';
  end if;

  select a.allow_cancellation, a.cancellation_cutoff_hours, s.starts_at, a.cancellation_refund_mode
    into v_allow, v_cutoff, v_starts, v_mode
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  where s.id = v_session;

  if not v_allow then
    raise exception 'The provider does not allow cancellations for this class.';
  end if;
  if v_starts - make_interval(hours => v_cutoff) < now() then
    raise exception 'The cancellation window for this class has closed (% hours before the session).', v_cutoff;
  end if;

  update public.bookings
  set status = 'cancelled',
      cancel_refund_mode = coalesce(v_mode, 'refund')
  where booking_group_id = p_group_id
    and user_id = v_user
    and status in ('pending', 'confirmed', 'waitlisted');
end;
$function$;

notify pgrst, 'reload schema';

commit;
