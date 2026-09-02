-- 00080_cancellation_compensation.sql
--
-- Make the parent whole automatically when a booking is cancelled:
--
--   * booked with a package credit  -> put one credit back on that pack
--     (a booking is one credit — quantity redemption inserts one row per
--     credit — so exactly one comes back). If the pack has since expired,
--     the credit is worthless, so issue a make-up token instead.
--   * booked with cash (payment_status = 'paid') -> issue a make-up token
--     for the provider, redeemable on any future class of theirs.
--   * cash already refunded, a free class, or a manual/guest booking with
--     no parent account -> nothing.
--
-- One AFTER UPDATE trigger so every cancel path is covered the same way:
-- the parent cancel_booking RPC, the vendor's direct status update on the
-- waitlist, and any future admin action. Sits alongside
-- notify_booking_cancelled (00033) and handle_booking_cancel (00008),
-- which already hang off this same status change.
--
-- The compensation token is deliberately different from a vendor-issued
-- one: it never expires, and it is hidden from the vendor portal (the
-- Make-up tokens list and the Notifications feed). It is an automatic
-- platform correction, not something the provider grants or manages — the
-- redeemed booking still shows on their roster as normal.

begin;

alter table public.make_up_tokens
  add column if not exists auto_issued boolean not null default false;

comment on column public.make_up_tokens.auto_issued is
  'True for a token minted automatically as cancellation compensation '
  '(00080). Never expires; hidden from the vendor portal.';

-- =============================================================
-- Compensation on cancellation
-- =============================================================
create or replace function public.compensate_cancelled_booking()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_pur            public.package_purchases;
  v_pack_usable    boolean := false;
  v_activity_title text;
  v_provider_name  text;
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

  select a.title, p.business_name
    into v_activity_title, v_provider_name
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  join public.providers   p on p.id = new.provider_id
  where s.id = new.session_id;

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

drop trigger if exists after_booking_cancel_compensate on public.bookings;
create trigger after_booking_cancel_compensate
  after update of status on public.bookings
  for each row execute function public.compensate_cancelled_booking();

-- =============================================================
-- Keep auto-issued tokens out of the vendor portal
-- =============================================================

-- Make-up tokens list (vendor "Make-up tokens" tab).
create or replace function public.provider_make_up_tokens(p_provider uuid)
returns table (
  token_id uuid,
  child_name text,
  parent_name text,
  origin_activity_title text,
  origin_session_at timestamptz,
  status text,
  created_at timestamptz,
  expires_at timestamptz
)
language plpgsql
stable security definer
set search_path = public
as $$
begin
  if p_provider not in (select public.user_provider_ids()) then
    raise exception 'not authorized';
  end if;

  return query
  select t.id, coalesce(c.name, 'Guest')::text, coalesce(par.full_name, 'Parent')::text,
         a.title, s.starts_at, t.status, t.created_at, t.expires_at
  from public.make_up_tokens t
  left join public.children c on c.id = t.child_id
  left join public.parent_profiles par on par.id = t.user_id
  left join public.bookings b on b.id = t.origin_booking_id
  left join public.activity_sessions s on s.id = b.session_id
  left join public.activities a on a.id = s.activity_id
  where t.provider_id = p_provider
    and not t.auto_issued
  order by t.created_at desc;
end;
$$;
grant execute on function public.provider_make_up_tokens(uuid) to authenticated;

-- Recent-activity feed (vendor "Notifications" tab) — the token_issued
-- stream only, everything else is unchanged from 00041.
create or replace function public.provider_notification_feed(p_provider uuid, p_limit integer default 30)
returns table (
  kind text,
  event_at timestamptz,
  actor_name text,
  activity_title text,
  detail text
)
language plpgsql
stable security definer
set search_path = public
as $$
begin
  if p_provider not in (select public.user_provider_ids()) then
    raise exception 'not authorized';
  end if;

  return query
  select * from (
    (
      select 'booking'::text, b.created_at, coalesce(c.name, b.guest_name, 'Guest')::text, a.title, null::text
      from public.bookings b
      join public.activity_sessions s on s.id = b.session_id
      join public.activities a on a.id = s.activity_id
      left join public.children c on c.id = b.child_id
      where b.provider_id = p_provider and b.status in ('confirmed', 'completed')
      order by b.created_at desc
      limit p_limit
    )
    union all
    (
      select 'waitlist'::text, b.created_at, coalesce(c.name, b.guest_name, 'Guest')::text, a.title, null::text
      from public.bookings b
      join public.activity_sessions s on s.id = b.session_id
      join public.activities a on a.id = s.activity_id
      left join public.children c on c.id = b.child_id
      where b.provider_id = p_provider and b.status = 'waitlisted'
      order by b.created_at desc
      limit p_limit
    )
    union all
    (
      select 'cancellation'::text, b.updated_at, coalesce(c.name, b.guest_name, 'Guest')::text, a.title, null::text
      from public.bookings b
      join public.activity_sessions s on s.id = b.session_id
      join public.activities a on a.id = s.activity_id
      left join public.children c on c.id = b.child_id
      where b.provider_id = p_provider and b.status = 'cancelled'
      order by b.updated_at desc
      limit p_limit
    )
    union all
    (
      select 'review'::text, r.created_at, coalesce(par.full_name, 'A parent')::text, a.title, r.rating::text
      from public.reviews r
      join public.activities a on a.id = r.activity_id
      left join public.parent_profiles par on par.id = r.user_id
      where a.provider_id = p_provider
      order by r.created_at desc
      limit p_limit
    )
    union all
    (
      select 'token_issued'::text, t.created_at, coalesce(c.name, 'A family')::text, null::text, null::text
      from public.make_up_tokens t
      left join public.children c on c.id = t.child_id
      where t.provider_id = p_provider
        and not t.auto_issued
      order by t.created_at desc
      limit p_limit
    )
  ) feed
  order by event_at desc
  limit p_limit;
end;
$$;
grant execute on function public.provider_notification_feed(uuid, integer) to authenticated;

notify pgrst, 'reload schema';

commit;
