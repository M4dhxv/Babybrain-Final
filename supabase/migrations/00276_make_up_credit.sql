-- 00276_make_up_credit.sql
--
-- Make-up tokens become MONEY, scoped to one vendor.
--
-- Until now a make-up token was "one booking". A parent who cancelled a $20 class got one token and
-- could only spend it on one class. From here a token carries an AMOUNT, and the parent's tokens with
-- one vendor add up to a balance they can spend on anything that vendor sells: a session, a party of
-- seats, a pack, extra people. Whatever the balance does not cover is paid by card.
--
--   balance $40, buys a $25 class        -> balance $15
--   cancels a $20 booking                -> balance $35
--   books a $50 class                    -> uses $35, pays $15 by card
--
-- Name: it stays "make-up token" in the product (packs already use the word "credit").
--
-- Shape of the change (nothing is dropped, so old portal / parent code keeps working through a deploy):
--
--   make_up_tokens            each row is now a LOT of credit: amount_cents (what it was issued for) and
--                             balance_cents (what is left). status stays 'issued' while a balance remains,
--                             'redeemed' once it is spent, 'expired' as before. Expiry is per lot, exactly as
--                             it was per token: a vendor can set one, an automatic one never expires.
--   make_up_token_spends      the ledger. Every cent taken out of a lot, what it paid for (a booking, a pack,
--                             an add-on, a Wix ticket), and whether it is still 'held' (reserved while the
--                             parent is on the Stripe page), 'applied' (the purchase went through) or
--                             'returned' (given back to its lot).
--   bookings.credit_cents     how much of a seat was paid with credit.
--   bookings.paid_by_credit   true when credit covered the whole seat (no card). payment_status stays 'none'
--                             for these, exactly as a redeemed token booking always was, so every existing
--                             "is this booking settled" check keeps its meaning.
--
-- Spending takes from the lot that expires soonest, an unexpiring lot last.
-- Refunds: a cancelled booking gives back what it cost, as credit, never as cash (BabyBrain does not
-- refund cash). The part that was paid with credit goes back to the lots it came from (with a fresh 30 days
-- if one had lapsed, as a returned token always did); the part that was paid by card becomes a new lot.
-- A booking cancelled before it was ever paid for (an abandoned checkout) simply gives its credit back.
--
-- Money rules the app routes rely on (see docs/make-up-credit.md):
--   * vendor scope: a spend always matches the lot's provider_id to the thing being bought.
--   * only the functions below, run as the service role or by a signed-in parent for their own balance,
--     change amount_cents / balance_cents. The vendor portal can still insert a token for a booking and set
--     an expiry (as today); a trigger fixes the amount to what that booking cost and refuses any direct
--     edit of the money columns.
--
-- Idempotent where it can be.

begin;

-- =============================================================
-- 1. Lots
-- =============================================================
alter table public.make_up_tokens
  add column if not exists amount_cents  int not null default 0,
  add column if not exists balance_cents int not null default 0;

comment on column public.make_up_tokens.amount_cents is
  'What this lot of make-up credit was issued for, in cents (the price of the booking it replaced).';
comment on column public.make_up_tokens.balance_cents is
  'What is left of it. Spendable while status = ''issued'' and it has not expired.';

alter table public.bookings
  add column if not exists credit_cents int not null default 0 check (credit_cents >= 0),
  add column if not exists paid_by_credit boolean not null default false;

alter table public.booking_addons
  add column if not exists credit_cents int not null default 0 check (credit_cents >= 0);
comment on column public.booking_addons.credit_cents is
  'How much of this add-on purchase was paid with make-up credit, in cents.';

comment on column public.bookings.credit_cents is
  'How much of this seat was paid with make-up credit, in cents. Set when the credit is reserved.';
comment on column public.bookings.paid_by_credit is
  'True when make-up credit covered the whole seat. payment_status stays ''none'' for these.';

-- =============================================================
-- 2. The ledger
-- =============================================================
create table if not exists public.make_up_token_spends (
  id           uuid primary key default gen_random_uuid(),
  token_id     uuid not null references public.make_up_tokens (id) on delete cascade,
  user_id      uuid not null,
  provider_id  uuid not null references public.providers (id) on delete cascade,
  amount_cents int  not null check (amount_cents > 0),
  status       text not null default 'held' check (status in ('held', 'applied', 'returned')),
  -- One checkout = one hold id, shared by every spend row it created.
  hold_id      uuid not null,
  -- What it paid for: 'booking' (booking_id set), 'package', 'addon', 'wix_booking', 'wix_event'.
  ref_kind     text not null default 'booking',
  ref_id       text,
  booking_id   uuid references public.bookings (id) on delete set null,
  created_at   timestamptz not null default now(),
  applied_at   timestamptz,
  returned_at  timestamptz
);

create index if not exists make_up_token_spends_token_idx   on public.make_up_token_spends (token_id);
create index if not exists make_up_token_spends_booking_idx on public.make_up_token_spends (booking_id) where booking_id is not null;
create index if not exists make_up_token_spends_hold_idx    on public.make_up_token_spends (hold_id);
create index if not exists make_up_token_spends_open_idx    on public.make_up_token_spends (status, created_at) where status = 'held';
create index if not exists make_up_token_spends_user_idx    on public.make_up_token_spends (user_id, provider_id);

alter table public.make_up_token_spends enable row level security;
drop policy if exists "parent reads own spends" on public.make_up_token_spends;
create policy "parent reads own spends" on public.make_up_token_spends
  for select using (user_id = auth.uid());
drop policy if exists "vendor reads own spends" on public.make_up_token_spends;
create policy "vendor reads own spends" on public.make_up_token_spends
  for select using (provider_id in (select public.user_provider_ids()));

-- =============================================================
-- 3. Backfill: every existing token becomes a lot worth what its booking cost
-- =============================================================
-- Value = what the parent paid for the booking the token replaced; else the class's price today. A token
-- with no booking to price it from, and a class with no price, is worth 0 and is reported at the end of
-- this migration rather than guessed at.
do $$
declare
  v_zero int;
begin
  perform set_config('bb.credit_write', 'on', true);

  update public.make_up_tokens t
     set amount_cents = coalesce(
           nullif(round(coalesce(b.amount, 0) * 100)::int, 0),
           nullif(round(coalesce(public.session_price(b.session_id), 0) * 100)::int, 0),
           0)
    from public.bookings b
   where b.id = t.origin_booking_id
     and t.amount_cents = 0;

  -- A token that was already spent keeps its value as spent, tied to the booking that used it, so
  -- cancelling that booking later gives the money back like any other credit-funded booking.
  update public.make_up_tokens
     set balance_cents = case when status = 'issued' then amount_cents else 0 end
   where balance_cents = 0 and amount_cents > 0;

  insert into public.make_up_token_spends
    (token_id, user_id, provider_id, amount_cents, status, hold_id, ref_kind, ref_id, booking_id, applied_at)
  select t.id, t.user_id, t.provider_id, t.amount_cents, 'applied', gen_random_uuid(), 'booking',
         t.redeemed_booking_id::text, t.redeemed_booking_id, now()
    from public.make_up_tokens t
   where t.status = 'redeemed'
     and t.amount_cents > 0
     and t.user_id is not null
     and t.redeemed_booking_id is not null
     and not exists (select 1 from public.make_up_token_spends s where s.token_id = t.id);

  update public.bookings b
     set credit_cents = s.amount_cents, paid_by_credit = true
    from public.make_up_token_spends s
   where s.booking_id = b.id and b.credit_cents = 0;

  select count(*) into v_zero from public.make_up_tokens where amount_cents = 0 and status = 'issued';
  if v_zero > 0 then
    raise notice 'make-up credit backfill: % unspent token(s) could not be priced and are worth 0 - review them', v_zero;
  end if;
end $$;

alter table public.make_up_tokens
  drop constraint if exists make_up_tokens_balance_range;
alter table public.make_up_tokens
  add constraint make_up_tokens_balance_range check (balance_cents >= 0 and balance_cents <= amount_cents);

create index if not exists make_up_tokens_spendable_idx
  on public.make_up_tokens (user_id, provider_id, expires_at nulls last)
  where status = 'issued' and balance_cents > 0;

-- =============================================================
-- 4. Who may write the money columns
-- =============================================================
-- A vendor can insert a token for a booking and edit its expiry from the portal (RLS "members manage
-- tokens"). They must not be able to type an amount or a balance. On a portal insert the amount is set
-- here to what the booking cost; on any direct update the money columns are frozen.
create or replace function public.make_up_tokens_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_privileged boolean :=
    coalesce(current_setting('bb.credit_write', true), '') = 'on'
    or coalesce(auth.role(), '') = 'service_role'
    or auth.uid() is null;
  v_cents int;
begin
  if tg_op = 'INSERT' then
    if not v_privileged then
      if new.origin_booking_id is null then
        raise exception 'A make-up token is issued for a booking.';
      end if;
      select coalesce(
               nullif(round(coalesce(b.amount, 0) * 100)::int, 0),
               nullif(round(coalesce(public.session_price(b.session_id), 0) * 100)::int, 0),
               0)
        into v_cents
      from public.bookings b
      where b.id = new.origin_booking_id and b.provider_id = new.provider_id;
      if v_cents is null then
        raise exception 'That booking is not one of yours.';
      end if;
      if v_cents <= 0 then
        raise exception 'This booking was free, so there is nothing to credit.';
      end if;
      new.amount_cents := v_cents;
      new.balance_cents := v_cents;
      new.status := 'issued';
      new.redeemed_booking_id := null;
    elsif new.balance_cents = 0 and new.amount_cents > 0 and new.status = 'issued' then
      new.balance_cents := new.amount_cents;
    end if;
    return new;
  end if;

  -- UPDATE
  if not v_privileged and (
       new.amount_cents is distinct from old.amount_cents
       or new.balance_cents is distinct from old.balance_cents
       or new.user_id is distinct from old.user_id
       or new.provider_id is distinct from old.provider_id) then
    raise exception 'The amount of a make-up token cannot be edited.';
  end if;
  return new;
end;
$$;

drop trigger if exists make_up_tokens_guard_trg on public.make_up_tokens;
create trigger make_up_tokens_guard_trg
  before insert or update on public.make_up_tokens
  for each row execute function public.make_up_tokens_guard();

-- =============================================================
-- 5. Balance and spending
-- =============================================================
-- Spendable balance of one parent with one vendor.
create or replace function public.make_up_credit_balance(p_user uuid, p_provider uuid)
returns int
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce(sum(t.balance_cents), 0)::int
  from public.make_up_tokens t
  where t.user_id = p_user
    and t.provider_id = p_provider
    and t.status = 'issued'
    and (t.expires_at is null or t.expires_at > now());
$$;

-- The parent's own balances, one row per vendor, for the Make-up tokens tab and the booking page.
create or replace function public.my_make_up_credit()
returns table (
  provider_id uuid,
  business_name text,
  logo_url text,
  balance_cents int,
  next_expiry timestamptz,
  lots int
)
language sql
stable
security definer
set search_path to 'public'
as $$
  select t.provider_id,
         p.business_name::text,
         p.logo_url::text,
         sum(t.balance_cents)::int,
         min(t.expires_at),
         count(*)::int
  from public.make_up_tokens t
  join public.providers p on p.id = t.provider_id
  where t.user_id = auth.uid()
    and t.status = 'issued'
    and t.balance_cents > 0
    and (t.expires_at is null or t.expires_at > now())
  group by t.provider_id, p.business_name, p.logo_url
  order by p.business_name;
$$;

-- Reserve credit for a purchase. `p_items` is the purchase split into the pieces that must be tracked
-- separately, in the order credit should fill them: [{"booking_id": "...", "cents": 1500}, ...] for seats,
-- or one item with no booking_id for a pack / add-on / ticket. Credit is taken from the soonest-expiring
-- lot first until the balance or the pieces run out; every piece is filled in full or in part, never more
-- than asked. Returns {"total": n, "items": [{"booking_id": ..., "cents": n}]} (cents actually reserved).
-- The credit is 'held' until the purchase settles (settle_make_up_credit_hold, or the booking being
-- confirmed) and handed back by release_make_up_credit_hold / the cancel trigger if it never does.
create or replace function public.reserve_make_up_credit(
  p_user uuid,
  p_provider uuid,
  p_hold uuid,
  p_ref_kind text,
  p_items jsonb,
  p_ref_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_item     jsonb;
  v_want     int;
  v_booking  uuid;
  v_addon    uuid;
  v_kind     text;
  v_ref      text;
  v_lot      record;
  v_take     int;
  v_got      int;
  v_total    int := 0;
  v_out      jsonb := '[]'::jsonb;
begin
  if p_user is null or p_provider is null or p_hold is null then
    raise exception 'user, provider and hold are required';
  end if;
  perform set_config('bb.credit_write', 'on', true);

  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    v_want := greatest(coalesce((v_item->>'cents')::int, 0), 0);
    v_booking := nullif(v_item->>'booking_id', '')::uuid;
    v_addon := nullif(v_item->>'addon_row_id', '')::uuid;
    v_kind := coalesce(nullif(v_item->>'ref_kind', ''), case when v_addon is not null then 'addon' else p_ref_kind end, 'booking');
    v_ref := coalesce(nullif(v_item->>'ref_id', ''), v_addon::text, v_booking::text, p_ref_id);
    v_got := 0;

    if v_booking is not null and not exists (
         select 1 from public.bookings b where b.id = v_booking and b.user_id = p_user and b.provider_id = p_provider) then
      raise exception 'That booking is not yours.';
    end if;
    if v_addon is not null and not exists (
         select 1 from public.booking_addons x where x.id = v_addon and x.user_id = p_user and x.provider_id = p_provider) then
      raise exception 'That add-on is not yours.';
    end if;

    -- Same order for every caller, so two checkouts of one parent lock the lots in the same sequence.
    for v_lot in
      select t.id, t.balance_cents
      from public.make_up_tokens t
      where t.user_id = p_user
        and t.provider_id = p_provider
        and t.status = 'issued'
        and t.balance_cents > 0
        and (t.expires_at is null or t.expires_at > now())
      order by t.expires_at nulls last, t.created_at, t.id
      for update
    loop
      exit when v_got >= v_want;
      v_take := least(v_lot.balance_cents, v_want - v_got);
      update public.make_up_tokens
         set balance_cents = balance_cents - v_take,
             status = case when balance_cents - v_take = 0 then 'redeemed' else status end
       where id = v_lot.id;
      insert into public.make_up_token_spends
        (token_id, user_id, provider_id, amount_cents, status, hold_id, ref_kind, ref_id, booking_id)
      values
        (v_lot.id, p_user, p_provider, v_take, 'held', p_hold, v_kind, v_ref, v_booking);
      v_got := v_got + v_take;
    end loop;

    if v_booking is not null and v_got > 0 then
      update public.bookings set credit_cents = credit_cents + v_got where id = v_booking;
    end if;
    if v_addon is not null and v_got > 0 then
      update public.booking_addons set credit_cents = credit_cents + v_got where id = v_addon;
    end if;
    v_total := v_total + v_got;
    v_out := v_out || jsonb_build_object('booking_id', v_booking, 'addon_row_id', v_addon, 'cents', v_got);
  end loop;

  return jsonb_build_object('total', v_total, 'items', v_out);
end;
$$;

-- Give credit back to its lots. `p_where` picks the spends: a booking and/or a hold, and which statuses.
-- A lot that had lapsed is given 30 days from now so the returned credit is not dead on arrival, exactly
-- as a returned token always was. Idempotent: a returned spend is never returned twice.
create or replace function public.return_make_up_credit(
  p_booking uuid default null,
  p_hold uuid default null,
  p_statuses text[] default array['held', 'applied'],
  p_ref_kind text default null,
  p_ref_id text default null
)
returns int
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_s     record;
  v_total int := 0;
begin
  if p_booking is null and p_hold is null and p_ref_id is null then
    raise exception 'Give a booking, a hold or a reference to return credit for.';
  end if;
  perform set_config('bb.credit_write', 'on', true);

  for v_s in
    select s.id, s.token_id, s.amount_cents, s.booking_id, s.ref_kind, s.ref_id
    from public.make_up_token_spends s
    where s.status = any (p_statuses)
      and (p_booking is null or s.booking_id = p_booking)
      and (p_hold is null or s.hold_id = p_hold)
      and (p_ref_id is null or (s.ref_id = p_ref_id and s.ref_kind = coalesce(p_ref_kind, s.ref_kind)))
    order by s.created_at, s.id
    for update
  loop
    update public.make_up_tokens
       set balance_cents = least(amount_cents, balance_cents + v_s.amount_cents),
           status = case when status = 'redeemed' then 'issued' else status end,
           expires_at = case
             when expires_at is not null and expires_at <= now() then now() + interval '30 days'
             else expires_at
           end
     where id = v_s.token_id;
    update public.make_up_token_spends
       set status = 'returned', returned_at = now()
     where id = v_s.id;
    if v_s.booking_id is not null then
      update public.bookings
         set credit_cents = greatest(credit_cents - v_s.amount_cents, 0),
             paid_by_credit = false
       where id = v_s.booking_id;
    end if;
    if v_s.ref_kind = 'addon' and v_s.ref_id is not null then
      update public.booking_addons
         set credit_cents = greatest(credit_cents - v_s.amount_cents, 0)
       where id = v_s.ref_id::uuid;
    end if;
    v_total := v_total + v_s.amount_cents;
  end loop;

  return v_total;
end;
$$;

-- A checkout that was abandoned, expired or failed: everything still 'held' for it goes back.
create or replace function public.release_make_up_credit_hold(p_hold uuid)
returns int
language sql
security definer
set search_path to 'public'
as $$
  select public.return_make_up_credit(null, p_hold, array['held']);
$$;

-- A checkout that was paid: its 'held' spends become 'applied' (the settled ledger).
create or replace function public.settle_make_up_credit_hold(p_hold uuid)
returns int
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_n int;
begin
  update public.make_up_token_spends
     set status = 'applied', applied_at = now()
   where hold_id = p_hold and status = 'held';
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- A seat that is confirmed (paid by card, by credit, or by a pack) has settled whatever credit it held.
create or replace function public.settle_credit_on_booking_confirm()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if new.status in ('confirmed', 'completed') and old.status is distinct from new.status then
    update public.make_up_token_spends
       set status = 'applied', applied_at = now()
     where booking_id = new.id and status = 'held';
  end if;
  return new;
end;
$$;

drop trigger if exists settle_credit_on_booking_confirm_trg on public.bookings;
create trigger settle_credit_on_booking_confirm_trg
  after update of status on public.bookings
  for each row execute function public.settle_credit_on_booking_confirm();

-- Add-on purchase rows are created per checkout and dropped (or marked cancelled) when it never pays,
-- so their credit follows the row: paid settles it, a delete or cancel hands it back.
create or replace function public.settle_credit_on_addon_row()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if tg_op = 'DELETE' then
    perform public.return_make_up_credit(null, null, array['held'], 'addon', old.id::text);
    return old;
  end if;
  if new.payment_status = 'paid' and old.payment_status is distinct from 'paid' then
    update public.make_up_token_spends
       set status = 'applied', applied_at = now()
     where ref_kind = 'addon' and ref_id = new.id::text and status = 'held';
  elsif new.payment_status = 'cancelled' and old.payment_status is distinct from 'cancelled' then
    perform public.return_make_up_credit(null, null, array['held'], 'addon', new.id::text);
  end if;
  return new;
end;
$$;

drop trigger if exists settle_credit_on_addon_row_trg on public.booking_addons;
create trigger settle_credit_on_addon_row_trg
  after update of payment_status or delete on public.booking_addons
  for each row execute function public.settle_credit_on_addon_row();

-- A seat that goes back to the waitlist (a waitlist claim that was not paid for in time) is no longer
-- paying for anything: its credit goes back too.
create or replace function public.return_credit_when_seat_leaves_pending()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if old.status = 'pending' and new.status = 'waitlisted' then
    perform public.return_make_up_credit(new.id, null, array['held']);
  end if;
  return new;
end;
$$;

drop trigger if exists return_credit_when_seat_leaves_pending_trg on public.bookings;
create trigger return_credit_when_seat_leaves_pending_trg
  after update of status on public.bookings
  for each row execute function public.return_credit_when_seat_leaves_pending();

-- A checkout that never finished and has no booking row to be cancelled (a pack, an add-on, a Wix ticket):
-- anything 'held' for over 90 minutes goes back. Seats are not in this list: a seat that is never paid is
-- cancelled by the 45-minute clean-up and the cancel trigger below returns its credit.
create or replace function public.release_stale_make_up_credit_holds()
returns int
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_h     record;
  v_total int := 0;
begin
  for v_h in
    select distinct s.hold_id
    from public.make_up_token_spends s
    where s.status = 'held'
      and s.booking_id is null
      and s.created_at < now() - interval '90 minutes'
  loop
    v_total := v_total + public.return_make_up_credit(null, v_h.hold_id, array['held']);
  end loop;
  return v_total;
end;
$$;

-- Credit-only confirmation of seats: what confirm_paid_booking_seats (00180) does for a card payment,
-- for seats that credit paid for in full. Same session lock, same capacity re-check for a seat claimed
-- from the waitlist. payment_status stays 'none' and paid_by_credit is set. A seat that could not be
-- seated keeps its place on the waitlist and has its credit handed back by the caller.
create or replace function public.confirm_credit_booking_seats(p_seat_ids uuid[])
returns table (id uuid, confirmed boolean)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_session_id uuid;
  v_capacity   int;
  v_taken      int;
  v_free       int;
  v_to_confirm uuid[];
begin
  if p_seat_ids is null or array_length(p_seat_ids, 1) is null then
    return;
  end if;
  select b.session_id into v_session_id from public.bookings b where b.id = p_seat_ids[1];
  if v_session_id is null then
    return;
  end if;
  perform 1 from public.activity_sessions s where s.id = v_session_id for update;
  select s.capacity into v_capacity from public.activity_sessions s where s.id = v_session_id;

  update public.bookings b
     set status = 'confirmed', paid_by_credit = true
   where b.id = any (p_seat_ids) and b.status = 'pending' and b.credit_cents > 0;

  select count(*) into v_taken from public.bookings b
   where b.session_id = v_session_id and b.status in ('pending', 'confirmed');
  v_free := case when v_capacity is null then 2147483647 else greatest(v_capacity - v_taken, 0) end;

  select coalesce(array_agg(w.id), '{}') into v_to_confirm
  from (
    select b.id from public.bookings b
    where b.id = any (p_seat_ids) and b.status = 'waitlisted' and b.credit_cents > 0
    order by b.waitlist_position nulls last, b.created_at
    limit v_free
  ) w;

  if array_length(v_to_confirm, 1) > 0 then
    update public.bookings b
       set status = 'confirmed', paid_by_credit = true, waitlist_position = null
     where b.id = any (v_to_confirm);
  end if;

  return query
  select b.id, (b.status = 'confirmed') from public.bookings b where b.id = any (p_seat_ids);
end;
$$;

-- =============================================================
-- 6. Cancelling a booking gives its money back as credit
-- =============================================================
-- 00205's function, reworked. In order:
--   0. Credit still 'held' on the booking was never settled (the checkout was abandoned or the seat lost
--      its place): it goes straight back, whatever the cancel mode, and that is the end of it unless the
--      seat had actually been paid by card.
--   1. The cash was already refunded: only the credit part goes back (it is not cash).
--   2. The vendor withholds a refund for this class ('none'): nothing goes back.
--   3. Paid with credit (all or part): that credit goes back to the lots it came from, and any part paid by
--      card becomes a new automatic lot. One notification says what the balance gained.
--   4. Booked against a pack credit: the credit goes back to the pack while it is usable (unchanged);
--      otherwise it falls through to a new lot worth what the class costs.
--   5. Paid by card only: a new automatic lot worth what was paid.
create or replace function public.compensate_cancelled_booking()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_pur            public.package_purchases;
  v_pack_usable    boolean := false;
  v_allowed        uuid[];
  v_activity_title text;
  v_activity_slug  text;
  v_activity_live  boolean;
  v_provider_name  text;
  v_mode           text;
  v_token_id       uuid;
  v_returned       int := 0;
  v_cash_cents     int := 0;
  v_value_cents    int := 0;
  v_gain           int := 0;
  v_url            text;
begin
  -- Only the transition INTO cancelled, once.
  if new.status <> 'cancelled' or old.status is not distinct from 'cancelled' then
    return new;
  end if;

  if new.user_id is null or new.provider_id is null then
    return new;
  end if;

  -- 0. Reserved but never settled.
  v_returned := public.return_make_up_credit(new.id, null, array['held']);
  if v_returned > 0 and new.payment_status <> 'paid' then
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

  if not coalesce(v_activity_live, false) then
    v_activity_slug := null;
  end if;
  v_url := case when v_activity_slug is not null then '/book?slug=' || v_activity_slug else '/profile?tab=makeup' end;

  -- 1. The cash already went back on this same update.
  if new.payment_status = 'refunded' then
    v_gain := public.return_make_up_credit(new.id, null, array['applied']);
    if v_gain > 0 then
      insert into public.notifications (user_id, type, title, body, data)
      values (new.user_id, 'make_up_token_returned', 'Make-up token balance updated',
        'The make-up token you used for ' || coalesce(v_activity_title, 'a class') || ' is back in your '
          || coalesce(v_provider_name, 'provider') || ' balance.',
        jsonb_build_object('activity_name', v_activity_title, 'provider_name', v_provider_name,
          'url', v_url, 'amount_cents', v_gain, 'booking_id', new.id));
    end if;
    return new;
  end if;

  -- 2. The provider withholds compensation for this class.
  if v_mode = 'none' then
    return new;
  end if;

  -- 3. Paid (all or part) with make-up credit.
  if exists (select 1 from public.make_up_token_spends s where s.booking_id = new.id and s.status = 'applied') then
    v_gain := public.return_make_up_credit(new.id, null, array['applied']);
    if new.payment_status = 'paid' then
      v_cash_cents := greatest(round(coalesce(new.amount, 0) * 100)::int - v_gain, 0);
      if v_cash_cents > 0 and not exists (select 1 from public.make_up_tokens where origin_booking_id = new.id) then
        insert into public.make_up_tokens
          (provider_id, user_id, child_id, origin_booking_id, status, issued_by, expires_at, auto_issued,
           amount_cents, balance_cents)
        values
          (new.provider_id, new.user_id, new.child_id, new.id, 'issued', null, null, true,
           v_cash_cents, v_cash_cents)
        returning id into v_token_id;
        v_gain := v_gain + v_cash_cents;
      end if;
    end if;
    insert into public.notifications (user_id, type, title, body, data)
    values (new.user_id, 'make_up_token_returned', 'Make-up token balance updated',
      'Your cancelled booking for ' || coalesce(v_activity_title, 'a class') || ' has gone back into your '
        || coalesce(v_provider_name, 'provider') || ' make-up token balance.',
      jsonb_build_object('activity_name', v_activity_title, 'provider_name', v_provider_name,
        'url', v_url, 'amount_cents', v_gain, 'token_id', v_token_id, 'booking_id', new.id));
    return new;
  end if;

  -- 4. Booked against a package credit.
  if new.package_purchase_id is not null then
    select * into v_pur
    from public.package_purchases
    where id = new.package_purchase_id
    for update;
    if not found then
      return new;
    end if;

    v_pack_usable := v_pur.status <> 'expired'
                     and (v_pur.expires_at is null or v_pur.expires_at > now());

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
          'url', case when v_activity_slug is not null then '/book?slug=' || v_activity_slug else '/profile?tab=packages' end,
          'booking_id', new.id,
          'package_purchase_id', v_pur.id
        )
      );
      return new;
    end if;
    -- pack expired, or limited to activities that are all gone: fall through to a new lot
    v_value_cents := round(coalesce(public.session_price(new.session_id), 0) * 100)::int;
  else
    -- No credit was spent, so only a paid booking earns compensation.
    if new.payment_status <> 'paid' then
      return new;
    end if;
    v_value_cents := coalesce(
      nullif(round(coalesce(new.amount, 0) * 100)::int, 0),
      round(coalesce(public.session_price(new.session_id), 0) * 100)::int, 0);
  end if;

  -- 5. A new automatic lot worth what the booking cost.
  if v_value_cents <= 0 then
    return new;
  end if;
  if exists (select 1 from public.make_up_tokens where origin_booking_id = new.id) then
    return new;  -- already compensated for this booking
  end if;

  insert into public.make_up_tokens
    (provider_id, user_id, child_id, origin_booking_id, status, issued_by, expires_at, auto_issued,
     amount_cents, balance_cents)
  values
    (new.provider_id, new.user_id, new.child_id, new.id, 'issued', null, null, true,
     v_value_cents, v_value_cents)
  returning id into v_token_id;

  insert into public.notifications (user_id, type, title, body, data)
  values (
    new.user_id,
    'make_up_token_issued',
    'Make-up token issued',
    'Your cancelled booking for ' || coalesce(v_activity_title, 'a class') ||
      ' is now $' || to_char(v_value_cents / 100.0, 'FM999990.00') || ' of make-up token with ' ||
      coalesce(v_provider_name, 'the provider') || '. Use it on anything they offer. It doesn''t expire.',
    jsonb_build_object(
      'activity_name', v_activity_title,
      'provider_name', v_provider_name,
      'url', v_url,
      'token_id', v_token_id,
      'booking_id', new.id,
      'amount_cents', v_value_cents
    )
  );

  return new;
end;
$$;

revoke all on function public.compensate_cancelled_booking() from public, anon, authenticated;

-- =============================================================
-- 7. A token a vendor issues by hand says how much it is for
-- =============================================================
create or replace function public.notify_manual_make_up_token()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_activity_title text;
  v_activity_slug  text;
  v_provider_name  text;
  v_expires_on     text;
begin
  if new.auto_issued or new.status <> 'issued' or new.user_id is null then
    return new;
  end if;

  select a.title, a.slug
    into v_activity_title, v_activity_slug
  from public.bookings b
  join public.activity_sessions s on s.id = b.session_id
  join public.activities a on a.id = s.activity_id
  where b.id = new.origin_booking_id;

  select p.business_name into v_provider_name
  from public.providers p
  where p.id = new.provider_id;

  if new.expires_at is not null then
    v_expires_on := to_char(new.expires_at at time zone 'Asia/Singapore', 'FMDD FMMonth YYYY');
  end if;

  insert into public.notifications (user_id, type, title, body, data)
  values (
    new.user_id,
    'make_up_token_issued',
    'Make-up token issued',
    coalesce(v_provider_name, 'Your provider') || ' has issued you $' ||
      to_char(new.amount_cents / 100.0, 'FM999990.00') || ' of make-up token' ||
      case when v_activity_title is not null then ' for ' || v_activity_title else '' end ||
      case when v_expires_on is not null
           then ' — use it before ' || v_expires_on || '.'
           else ' — it doesn''t expire.' end,
    jsonb_build_object(
      'manual', true,
      'activity_name', v_activity_title,
      'provider_name', v_provider_name,
      'expires_on', v_expires_on,
      'url', case when v_activity_slug is not null
               then '/book?slug=' || v_activity_slug
               else '/profile?tab=makeup' end,
      'token_id', new.id,
      'booking_id', new.origin_booking_id,
      'amount_cents', new.amount_cents
    )
  );

  return new;
end;
$$;

-- =============================================================
-- 8. The old one-click redemption, kept for links and tabs opened before this shipped
-- =============================================================
-- Same arguments and result as 00257. The token id now only says "use my balance with this vendor": the
-- seat is paid from the parent's whole balance with the class's vendor, and only if that covers the class.
-- Anything the balance does not cover is paid on the booking page, which is where parents are sent now.
create or replace function public.redeem_make_up_token(
  p_token_id uuid,
  p_session_id uuid,
  p_policies uuid[] default '{}',
  p_medical text default null,
  p_info text default null
)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_user       uuid := auth.uid();
  v_tok        public.make_up_tokens;
  v_provider   uuid;
  v_term_slot  uuid;
  v_booking_id uuid;
  v_status     text;
  v_price      int;
  v_got        jsonb;
begin
  if v_user is null then
    raise exception 'Not authenticated';
  end if;

  select * into v_tok
  from public.make_up_tokens
  where id = p_token_id and user_id = v_user
  for update;
  if not found then
    raise exception 'This make-up token is not available';
  end if;

  select a.provider_id, s.term_slot_id into v_provider, v_term_slot
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  where s.id = p_session_id;
  if v_provider is null or v_provider <> v_tok.provider_id then
    raise exception 'This token can only be used for its provider''s classes';
  end if;

  v_price := round(coalesce(public.session_price(p_session_id), 0) * 100)::int;
  if v_price > 0 and public.make_up_credit_balance(v_user, v_provider) < v_price then
    raise exception 'Your make-up token balance with this provider does not cover this class. Choose the class on the booking page to pay the difference.';
  end if;

  if v_term_slot is not null then
    perform set_config('bb.term_booking_kind', 'makeup', true);
  end if;

  insert into public.bookings (user_id, session_id, child_id, policies_accepted, medical_disclosure, info_response)
  values (
    v_user, p_session_id, v_tok.child_id, coalesce(p_policies, '{}'::uuid[]),
    nullif(btrim(p_medical), ''), nullif(btrim(p_info), '')
  )
  returning id, status into v_booking_id, v_status;

  perform set_config('bb.term_booking_kind', '', true);

  if v_status = 'pending' then
    -- Credit before confirming: the confirm trigger settles whatever is held on the seat.
    if v_price > 0 then
      v_got := public.reserve_make_up_credit(v_user, v_provider, gen_random_uuid(), 'booking',
        jsonb_build_array(jsonb_build_object('booking_id', v_booking_id, 'cents', v_price)));
      if coalesce((v_got->>'total')::int, 0) < v_price then
        raise exception 'Your make-up token balance with this provider does not cover this class.';
      end if;
      update public.bookings set status = 'confirmed', paid_by_credit = true where id = v_booking_id;
    else
      update public.bookings set status = 'confirmed' where id = v_booking_id;
    end if;
    v_status := 'confirmed';
  end if;

  return v_status;
end;
$function$;

-- =============================================================
-- 9. Vendor lists
-- =============================================================
drop function if exists public.provider_make_up_tokens(uuid, boolean);
create function public.provider_make_up_tokens(p_provider uuid, p_include_auto boolean default false)
returns table (
  token_id uuid,
  child_name text,
  parent_name text,
  origin_activity_title text,
  origin_session_at timestamptz,
  status text,
  created_at timestamptz,
  expires_at timestamptz,
  auto_issued boolean,
  amount_cents int,
  balance_cents int,
  parent_id uuid
)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if p_provider not in (select public.user_provider_ids()) then
    raise exception 'not authorized';
  end if;

  return query
  select t.id, coalesce(c.name, 'Guest')::text, coalesce(par.full_name, 'Parent')::text,
         a.title, s.starts_at, t.status, t.created_at, t.expires_at, t.auto_issued,
         t.amount_cents, t.balance_cents, t.user_id
  from public.make_up_tokens t
  left join public.children c on c.id = t.child_id
  left join public.parent_profiles par on par.id = t.user_id
  left join public.bookings b on b.id = t.origin_booking_id
  left join public.activity_sessions s on s.id = b.session_id
  left join public.activities a on a.id = s.activity_id
  where t.provider_id = p_provider
    and (p_include_auto or not t.auto_issued)
  order by t.created_at desc;
end;
$$;
revoke all on function public.provider_make_up_tokens(uuid, boolean) from public, anon;
grant execute on function public.provider_make_up_tokens(uuid, boolean) to authenticated;

-- =============================================================
-- 10. Grants: money functions are for the server (service role) only, except the parent's own read
-- =============================================================
revoke all on function public.make_up_credit_balance(uuid, uuid) from public, anon, authenticated;
revoke all on function public.reserve_make_up_credit(uuid, uuid, uuid, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.return_make_up_credit(uuid, uuid, text[], text, text) from public, anon, authenticated;
revoke all on function public.settle_credit_on_addon_row() from public, anon, authenticated;
revoke all on function public.return_credit_when_seat_leaves_pending() from public, anon, authenticated;
revoke all on function public.release_make_up_credit_hold(uuid) from public, anon, authenticated;
revoke all on function public.settle_make_up_credit_hold(uuid) from public, anon, authenticated;
revoke all on function public.release_stale_make_up_credit_holds() from public, anon, authenticated;
revoke all on function public.confirm_credit_booking_seats(uuid[]) from public, anon, authenticated;
revoke all on function public.settle_credit_on_booking_confirm() from public, anon, authenticated;
revoke all on function public.make_up_tokens_guard() from public, anon, authenticated;
grant execute on function public.make_up_credit_balance(uuid, uuid) to service_role;
grant execute on function public.reserve_make_up_credit(uuid, uuid, uuid, text, jsonb, text) to service_role;
grant execute on function public.return_make_up_credit(uuid, uuid, text[], text, text) to service_role;
grant execute on function public.release_make_up_credit_hold(uuid) to service_role;
grant execute on function public.settle_make_up_credit_hold(uuid) to service_role;
grant execute on function public.release_stale_make_up_credit_holds() to service_role;
grant execute on function public.confirm_credit_booking_seats(uuid[]) to service_role;

revoke all on function public.my_make_up_credit() from public, anon;
grant execute on function public.my_make_up_credit() to authenticated;


-- =============================================================
-- 11. Places that read "paid with a token" now also see credit
-- =============================================================
-- Copies of the latest definitions (00140 roster, 00216 bookings table, 00270 admin booking) with one
-- change each: a seat paid for in full with make-up credit (paid_by_credit) counts as paid by token, as a
-- seat with a redeemed one-booking token always did, and the admin tool spends from the customer's
-- balance with the class's vendor instead of burning one token.

create or replace function public.provider_session_roster(p_session_id uuid)
returns table(
  booking_id uuid, status text, payment_status text, child_name text,
  child_age_months integer, has_medical boolean, waitlist_position integer,
  attendance_status text, child_id uuid, skill_level text, is_manual boolean,
  user_id uuid, parent_name text, medical_disclosure text,
  policies_accepted integer, info_response text, paid_via text,
  waitlist_pay_invited boolean, group_primary_name text, wix_booking_id text
)
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
  v_provider uuid;
  v_activity uuid;
  v_price numeric;
  v_wix_type text;
  v_query_session_id uuid := p_session_id;
begin
  select a.provider_id, a.id, coalesce(s.price, a.price), a.wix_service_type
    into v_provider, v_activity, v_price, v_wix_type
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  where s.id = p_session_id;

  if v_provider is null or v_provider not in (select public.user_provider_ids()) then
    raise exception 'not authorized';
  end if;

  if v_wix_type = 'COURSE' then
    select s2.id into v_query_session_id
    from public.activity_sessions s2
    where s2.activity_id = v_activity
      and s2.wix_slot_key like 'wixcourse:%'
    limit 1;
    v_query_session_id := coalesce(v_query_session_id, p_session_id);
  end if;

  return query
    select b.id,
           b.status,
           b.payment_status,
           public.booking_display_name(c.name, b.guest_name, par.full_name),
           case when c.date_of_birth is not null
                then public.child_age_months(c.date_of_birth) end,
           b.medical_disclosure is not null,
           b.waitlist_position,
           at.status,
           b.child_id,
           sl.level,
           -- A manual entry is the vendor's own offline record: no parent
           -- account. A party companion seat also has a guest_name but keeps
           -- its parent's user_id, so it is not manual.
           b.user_id is null and b.guest_name is not null,
           b.user_id,
           par.full_name,
           b.medical_disclosure,
           (select count(*)::int from public.booking_policy_acceptances bpa
             where bpa.booking_id = b.id),
           b.info_response,
           case
             when b.payment_status = 'refunded' then 'refunded'
             when b.package_purchase_id is not null then 'credit'
             when b.paid_by_credit or exists (
               select 1 from public.make_up_tokens mt
               where mt.redeemed_booking_id = b.id
             ) then 'token'
             when b.payment_status = 'paid' then 'cash'
             when coalesce(v_price, 0) = 0 then 'free'
             else 'none'
           end,
           b.waitlist_pay_invited,
           -- For a companion seat of a party (00084), the name on the seat
           -- that carries the real child — shown as a "With <name>" tag.
           case when b.booking_group_id is not null and b.child_id is null then (
             select gc.name
             from public.bookings gb
             join public.children gc on gc.id = gb.child_id
             where gb.booking_group_id = b.booking_group_id
               and gb.child_id is not null
             order by gb.created_at
             limit 1
           ) end,
           b.wix_booking_id
    from public.bookings b
    left join public.children c on c.id = b.child_id
    left join public.parent_profiles par on par.id = b.user_id
    left join public.attendance at on at.booking_id = b.id
    left join public.child_skill_levels sl on sl.child_id = b.child_id and sl.activity_id = v_activity
    where b.session_id = v_query_session_id
    order by b.waitlist_position nulls first, b.created_at;
end;
$function$;

create or replace function public.provider_bookings_table(
  p_provider uuid,
  p_from timestamptz,
  p_limit integer default 2000
)
returns table(
  group_key text, session_id uuid, starts_at timestamptz, activity_id uuid,
  activity_title text, wix_service_type text, location text, user_id uuid,
  parent_name text, parent_contact text, is_manual boolean,
  booked_at timestamptz, children jsonb
)
language plpgsql
stable security definer
set search_path to 'public'
as $function$
#variable_conflict use_column
begin
  if p_provider is null or p_provider not in (select public.user_provider_ids()) then
    raise exception 'not authorized';
  end if;

  return query
    select
      coalesce(b.booking_group_id::text, b.id::text),
      s.id,
      s.starts_at,
      a.id,
      a.title,
      a.wix_service_type,
      coalesce(nullif(btrim(s.studio), ''), nullif(btrim(pl.name), ''), nullif(btrim(a.address), '')),
      b.user_id,
      par.full_name,
      max(b.guest_contact),
      bool_and(b.user_id is null and b.guest_name is not null),
      min(b.created_at),
      jsonb_agg(
        jsonb_build_object(
          'booking_id', b.id,
          'name', public.booking_display_name(c.name, b.guest_name, par.full_name),
          'age_months', case when c.date_of_birth is not null
                             then public.child_age_months(c.date_of_birth) end,
          'status', b.status,
          'waitlist_position', b.waitlist_position,
          'child_id', b.child_id,
          'has_medical', b.medical_disclosure is not null,
          'medical_disclosure', b.medical_disclosure,
          'info_response', b.info_response,
          'policies_accepted', (select count(*)::int from public.booking_policy_acceptances bpa
                                 where bpa.booking_id = b.id),
          'attendance_status', at.status,
          'paid_via', case
            when b.payment_status = 'refunded' then 'refunded'
            when b.package_purchase_id is not null then 'credit'
            when b.paid_by_credit or exists (select 1 from public.make_up_tokens mt
                          where mt.redeemed_booking_id = b.id) then 'token'
            when b.payment_status = 'paid' then 'cash'
            when coalesce(s.price, a.price, 0) = 0 then 'free'
            else 'none'
          end
        )
        order by b.waitlist_position nulls first, b.created_at
      )
    from public.bookings b
    join public.activity_sessions s on s.id = b.session_id
    join public.activities a on a.id = s.activity_id
    left join public.provider_locations pl on pl.id = a.location_id
    left join public.children c on c.id = b.child_id
    left join public.parent_profiles par on par.id = b.user_id
    left join public.attendance at on at.booking_id = b.id
    where a.provider_id = p_provider
      and s.starts_at >= p_from
    group by coalesce(b.booking_group_id::text, b.id::text), s.id, s.starts_at,
             a.id, a.title, a.wix_service_type,
             coalesce(nullif(btrim(s.studio), ''), nullif(btrim(pl.name), ''), nullif(btrim(a.address), '')),
             b.user_id, par.full_name
    order by s.starts_at, 1
    limit greatest(coalesce(p_limit, 2000), 1);
end;
$function$;

create or replace function public.admin_booking_checks(
  p_user_id uuid,
  p_session_id uuid,
  p_method text,
  p_purchase_id uuid default null,
  p_token_id uuid default null,
  p_child_id uuid default null,
  p_allow_over_capacity boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_checks   jsonb := '[]'::jsonb;
  v_ok       boolean := true;
  v_s        record;
  v_parent   record;
  v_child    record;
  v_pur      record;
  v_pkg      record;
  v_tok      record;
  v_origin   record;
  v_fund_provider uuid;
  v_fund_vendor   text;
  v_fund jsonb := 'null'::jsonb;
  v_taken int;
  v_dupe  int;
  v_wix   boolean;
  v_term  boolean;
  v_child_id uuid := p_child_id;
begin
  if p_method not in ('credit', 'token', 'manual') then
    return jsonb_build_object('ok', false, 'checks', jsonb_build_array(jsonb_build_object(
      'key', 'method', 'label', 'Booking type', 'ok', false, 'detail', 'Choose credit, make-up token or manual booking.')));
  end if;

  -- ---- the class ----------------------------------------------------------
  select s.id, s.starts_at, s.capacity, s.activity_id, s.wix_slot_key,
         to_jsonb(s)->>'term_slot_id' as term_slot_id,
         a.title, a.provider_id, a.wix_service_id, a.wix_service_type, a.wix_event_id,
         pr.business_name as vendor, pr.status as provider_status
    into v_s
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  left join public.providers pr on pr.id = a.provider_id
  where s.id = p_session_id;

  if not found then
    return jsonb_build_object('ok', false, 'checks', jsonb_build_array(jsonb_build_object(
      'key', 'class', 'label', 'Class found', 'ok', false, 'detail', 'That class time no longer exists.')));
  end if;

  v_checks := v_checks || jsonb_build_object('key', 'class', 'label', 'Class found', 'ok', true,
    'detail', coalesce(v_s.title, 'Class') || ' · ' || coalesce(v_s.vendor, 'no vendor'));

  v_checks := v_checks || jsonb_build_object('key', 'upcoming', 'label', 'Class has not started', 'ok', v_s.starts_at > now(),
    'detail', case when v_s.starts_at > now() then 'Starts ' || to_char(v_s.starts_at at time zone 'Asia/Singapore', 'Dy DD Mon, HH12:MI AM')
                   else 'This class has already started.' end);

  v_checks := v_checks || jsonb_build_object('key', 'vendor_active', 'label', 'Vendor is taking bookings',
    'ok', coalesce(v_s.provider_status, 'active') = 'active',
    'detail', case when coalesce(v_s.provider_status, 'active') = 'active' then coalesce(v_s.vendor, 'Vendor') || ' is active'
                   else coalesce(v_s.vendor, 'This vendor') || ' is ' || v_s.provider_status || ', not active.' end);

  -- ---- capacity -----------------------------------------------------------
  if v_s.capacity is not null then
    select count(*) into v_taken from public.bookings b
    where b.session_id = p_session_id and b.status in ('pending', 'confirmed');
    if v_taken >= v_s.capacity then
      if p_method = 'manual' and p_allow_over_capacity then
        v_wix := v_s.wix_slot_key is not null or v_s.wix_service_id is not null
                 or v_s.wix_service_type is not null or v_s.wix_event_id is not null;
        v_checks := v_checks || jsonb_build_object('key', 'capacity', 'label', 'Seat available', 'ok', not v_wix,
          'detail', case when v_wix then 'This class is full and its capacity is managed on Wix, so it cannot be raised here.'
                         else 'Class is full (' || v_taken || ' of ' || v_s.capacity || '). Capacity will be raised by one for this booking.' end);
      else
        v_checks := v_checks || jsonb_build_object('key', 'capacity', 'label', 'Seat available', 'ok', false,
          'detail', 'Class is full (' || v_taken || ' of ' || v_s.capacity || ').'
                    || case when p_method = 'manual' then ' Tick "Add even though the class is full" to raise capacity by one.'
                            else ' A full class would put the customer on the waitlist and spend nothing.' end);
      end if;
    else
      v_checks := v_checks || jsonb_build_object('key', 'capacity', 'label', 'Seat available', 'ok', true,
        'detail', (v_s.capacity - v_taken) || ' of ' || v_s.capacity || ' seats left');
    end if;
  end if;

  -- ---- manual booking stops here (no customer account, nothing to spend) ---
  if p_method = 'manual' then
    select bool_and((c->>'ok')::boolean) into v_ok from jsonb_array_elements(v_checks) c;
    return jsonb_build_object(
      'ok', coalesce(v_ok, false), 'checks', v_checks,
      'class', jsonb_build_object('title', v_s.title, 'vendor', v_s.vendor, 'vendor_id', v_s.provider_id, 'starts_at', v_s.starts_at),
      'funding', null);
  end if;

  -- ---- credits and tokens: booking paths that live elsewhere --------------
  v_wix := v_s.wix_slot_key is not null or v_s.wix_service_id is not null
           or v_s.wix_service_type is not null or v_s.wix_event_id is not null;
  v_term := v_s.term_slot_id is not null;
  v_checks := v_checks || jsonb_build_object('key', 'path', 'label', 'Can be booked from here', 'ok', not v_wix and not v_term,
    'detail', case when v_wix then 'This class is linked to Wix. Book it through the customer''s app so Wix is updated too.'
                   when v_term then 'This class belongs to a term. Use the term enrolment tools instead.'
                   else 'Native BabyBrain class' end);

  -- ---- the customer -------------------------------------------------------
  select pp.id, pp.full_name, pp.email into v_parent from public.parent_profiles pp where pp.id = p_user_id;
  v_checks := v_checks || jsonb_build_object('key', 'customer', 'label', 'Customer account found', 'ok', found,
    'detail', case when found then coalesce(nullif(v_parent.full_name, ''), v_parent.email) || ' · ' || v_parent.email
                   else 'No customer account with that id.' end);

  -- ---- the credit or token: the cross-check -------------------------------
  if p_method = 'credit' then
    select * into v_pur from public.package_purchases where id = p_purchase_id;
    if not found then
      v_checks := v_checks || jsonb_build_object('key', 'funding', 'label', 'Credit found', 'ok', false, 'detail', 'Choose one of the customer''s packs.');
    else
      select * into v_pkg from public.packages where id = v_pur.package_id;
      v_fund_provider := v_pur.provider_id;
      select business_name into v_fund_vendor from public.providers where id = v_fund_provider;
      v_fund := jsonb_build_object('kind', 'credit', 'label', coalesce(v_pkg.name, 'Package'), 'vendor', v_fund_vendor,
        'vendor_id', v_fund_provider, 'remaining', v_pur.credits_remaining, 'total', v_pur.credits_total, 'expires_at', v_pur.expires_at);

      v_checks := v_checks || jsonb_build_object('key', 'owner', 'label', 'Credit belongs to this customer', 'ok', v_pur.user_id = p_user_id,
        'detail', case when v_pur.user_id = p_user_id then 'Pack is in this customer''s account'
                       else 'This pack belongs to a different customer.' end);

      v_checks := v_checks || jsonb_build_object('key', 'vendor_match', 'label', 'Credit vendor matches the class vendor',
        'ok', v_fund_provider is not distinct from v_s.provider_id and v_pkg.provider_id is not distinct from v_s.provider_id,
        'detail', case when v_fund_provider is not distinct from v_s.provider_id and v_pkg.provider_id is not distinct from v_s.provider_id
                       then 'Both are ' || coalesce(v_s.vendor, 'the same vendor')
                       else 'Credit is from ' || coalesce(v_fund_vendor, 'another vendor') || ' but the class is run by ' || coalesce(v_s.vendor, 'another vendor') || '.' end);

      v_checks := v_checks || jsonb_build_object('key', 'active', 'label', 'Pack is active and not expired',
        'ok', v_pur.status = 'active' and (v_pur.expires_at is null or v_pur.expires_at > now()),
        'detail', case when v_pur.status <> 'active' then 'Pack status is "' || v_pur.status || '".'
                       when v_pur.expires_at is not null and v_pur.expires_at <= now() then 'Pack expired ' || to_char(v_pur.expires_at at time zone 'Asia/Singapore', 'DD Mon YYYY') || '.'
                       when v_pur.expires_at is null then 'Active, no expiry'
                       else 'Active until ' || to_char(v_pur.expires_at at time zone 'Asia/Singapore', 'DD Mon YYYY') end);

      v_checks := v_checks || jsonb_build_object('key', 'balance', 'label', 'Pack has a credit left', 'ok', v_pur.credits_remaining >= 1,
        'detail', v_pur.credits_remaining || ' of ' || v_pur.credits_total || ' credits left'
                  || case when v_pur.credits_remaining >= 1 then ' (will be ' || (v_pur.credits_remaining - 1) || ' after this booking)' else '' end);

      v_checks := v_checks || jsonb_build_object('key', 'pack_rules', 'label', 'Class is allowed by the pack',
        'ok', not (
               (v_pkg.activity_ids is not null and array_length(v_pkg.activity_ids, 1) > 0 and not (v_s.activity_id = any(v_pkg.activity_ids)))
            or (v_pkg.allowed_weekday is not null and extract(dow from v_s.starts_at at time zone 'Asia/Singapore') <> v_pkg.allowed_weekday)
            or (v_pkg.allowed_start_time is not null and (v_s.starts_at at time zone 'Asia/Singapore')::time <> v_pkg.allowed_start_time)),
        'detail', case
            when v_pkg.activity_ids is not null and array_length(v_pkg.activity_ids, 1) > 0 and not (v_s.activity_id = any(v_pkg.activity_ids))
              then 'This pack is limited to specific classes and this is not one of them.'
            when v_pkg.allowed_weekday is not null and extract(dow from v_s.starts_at at time zone 'Asia/Singapore') <> v_pkg.allowed_weekday
              then 'This pack can only be used on its designated weekday.'
            when v_pkg.allowed_start_time is not null and (v_s.starts_at at time zone 'Asia/Singapore')::time <> v_pkg.allowed_start_time
              then 'This pack can only be used for its designated start time.'
            else 'No class, weekday or time limit is broken' end);
    end if;
  else
    select * into v_tok from public.make_up_tokens where id = p_token_id;
    if not found then
      v_checks := v_checks || jsonb_build_object('key', 'funding', 'label', 'Make-up token found', 'ok', false, 'detail', 'Choose one of the customer''s make-up tokens.');
    else
      v_fund_provider := v_tok.provider_id;
      select business_name into v_fund_vendor from public.providers where id = v_fund_provider;
      v_fund := jsonb_build_object('kind', 'token', 'label', 'Make-up token balance', 'vendor', v_fund_vendor,
        'vendor_id', v_fund_provider, 'remaining', public.make_up_credit_balance(p_user_id, v_fund_provider),
        'total', public.make_up_credit_balance(p_user_id, v_fund_provider), 'expires_at', v_tok.expires_at);
      v_child_id := coalesce(v_tok.child_id, p_child_id);

      v_checks := v_checks || jsonb_build_object('key', 'owner', 'label', 'Token belongs to this customer', 'ok', v_tok.user_id = p_user_id,
        'detail', case when v_tok.user_id = p_user_id then 'Token is in this customer''s account'
                       else 'This token belongs to a different customer.' end);

      v_checks := v_checks || jsonb_build_object('key', 'vendor_match', 'label', 'Token vendor matches the class vendor',
        'ok', v_fund_provider is not distinct from v_s.provider_id,
        'detail', case when v_fund_provider is not distinct from v_s.provider_id then 'Both are ' || coalesce(v_s.vendor, 'the same vendor')
                       else 'Token is from ' || coalesce(v_fund_vendor, 'another vendor') || ' but the class is run by ' || coalesce(v_s.vendor, 'another vendor') || '.' end);

      -- Make-up credit is money kept with the vendor (00276): the class is paid from the customer's whole
      -- balance with this vendor, so the balance has to cover its price.
      v_checks := v_checks || jsonb_build_object('key', 'active', 'label', 'Make-up token balance covers the class',
        'ok', round(coalesce(public.session_price(p_session_id), 0) * 100)::int > 0
              and public.make_up_credit_balance(p_user_id, v_fund_provider) >= round(coalesce(public.session_price(p_session_id), 0) * 100)::int,
        'detail', 'Balance with this vendor $' || to_char(public.make_up_credit_balance(p_user_id, v_fund_provider) / 100.0, 'FM999990.00')
                  || ', class costs $' || to_char(coalesce(public.session_price(p_session_id), 0), 'FM999990.00') || '.');

      -- Where the token came from must be the same vendor too. A token with no
      -- origin booking was issued by hand and has nothing to compare.
      if v_tok.origin_booking_id is not null then
        select b.provider_id, a.title into v_origin
        from public.bookings b
        left join public.activity_sessions os on os.id = b.session_id
        left join public.activities a on a.id = os.activity_id
        where b.id = v_tok.origin_booking_id;
        v_checks := v_checks || jsonb_build_object('key', 'token_origin', 'label', 'Token came from this vendor''s cancelled class',
          'ok', found and v_origin.provider_id is not distinct from v_tok.provider_id,
          'detail', case when not found then 'The booking this token was issued for no longer exists.'
                         when v_origin.provider_id is not distinct from v_tok.provider_id then 'Issued for a cancelled "' || coalesce(v_origin.title, 'class') || '"'
                         else 'The cancelled booking behind this token belongs to a different vendor.' end);
      end if;
    end if;
  end if;

  -- ---- child and duplicates ----------------------------------------------
  if v_child_id is not null then
    select c.id, c.name, c.parent_id into v_child from public.children c where c.id = v_child_id;
    v_checks := v_checks || jsonb_build_object('key', 'child', 'label', 'Child belongs to this customer',
      'ok', found and v_child.parent_id = p_user_id,
      'detail', case when not found then 'That child no longer exists.'
                     when v_child.parent_id = p_user_id then v_child.name
                     else 'That child is on a different customer''s account.' end);
    if p_method = 'token' then
      if p_child_id is not null and v_tok.child_id is not null and v_tok.child_id <> p_child_id then
        v_checks := v_checks || jsonb_build_object('key', 'token_child', 'label', 'Token is for this child', 'ok', false,
          'detail', 'This token was issued for a different child.');
      end if;
    end if;
  end if;

  select count(*) into v_dupe from public.bookings b
  where b.session_id = p_session_id and b.user_id = p_user_id
    and b.status in ('pending', 'confirmed', 'waitlisted', 'completed')
    and (v_child_id is null or b.child_id is null or b.child_id = v_child_id);
  v_checks := v_checks || jsonb_build_object('key', 'duplicate', 'label', 'Not already booked into this class', 'ok', v_dupe = 0,
    'detail', case when v_dupe = 0 then 'No existing booking for this customer in this class'
                   else 'This customer already has a booking in this class.' end);

  select bool_and((c->>'ok')::boolean) into v_ok from jsonb_array_elements(v_checks) c;
  return jsonb_build_object(
    'ok', coalesce(v_ok, false), 'checks', v_checks,
    'class', jsonb_build_object('title', v_s.title, 'vendor', v_s.vendor, 'vendor_id', v_s.provider_id, 'starts_at', v_s.starts_at),
    'funding', v_fund);
end;
$$;

create or replace function public.admin_create_booking(
  p_user_id uuid,
  p_session_id uuid,
  p_method text,
  p_purchase_id uuid default null,
  p_token_id uuid default null,
  p_child_id uuid default null,
  p_guest_name text default null,
  p_guest_contact text default null,
  p_paid boolean default false,
  p_allow_over_capacity boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_check   jsonb;
  v_bad     text;
  v_cap     int;
  v_taken   int;
  v_raised  boolean := false;
  v_pur     public.package_purchases;
  v_tok     public.make_up_tokens;
  v_child   uuid := p_child_id;
  v_id      uuid;
  v_status  text;
  v_before  int;
  v_after   int;
  v_n       int;
begin
  if p_method not in ('credit', 'token', 'manual') then
    raise exception 'Choose credit, make-up token or manual booking.';
  end if;
  if p_method = 'manual' and nullif(btrim(p_guest_name), '') is null then
    raise exception 'A name is required for a manual booking.';
  end if;

  -- Same lock handle_booking_insert takes, held to the end of this transaction.
  select s.capacity into v_cap from public.activity_sessions s where s.id = p_session_id for update;
  if not found then
    raise exception 'That class time no longer exists.';
  end if;

  -- Lock the credit / token so two admins (or an admin and the customer) cannot spend it twice.
  if p_method = 'credit' then
    select * into v_pur from public.package_purchases where id = p_purchase_id for update;
  elsif p_method = 'token' then
    select * into v_tok from public.make_up_tokens where id = p_token_id for update;
  end if;

  -- The safeguard: the very same checks the admin saw, run again under the locks.
  v_check := public.admin_booking_checks(p_user_id, p_session_id, p_method, p_purchase_id, p_token_id, p_child_id, p_allow_over_capacity);
  if not coalesce((v_check->>'ok')::boolean, false) then
    select c->>'detail' into v_bad from jsonb_array_elements(v_check->'checks') c where (c->>'ok')::boolean is not true limit 1;
    raise exception 'Not booked. %', coalesce(v_bad, 'Verification failed.');
  end if;

  -- ---- manual ---------------------------------------------------------------
  if p_method = 'manual' then
    if v_cap is not null then
      select count(*) into v_taken from public.bookings b where b.session_id = p_session_id and b.status in ('pending', 'confirmed');
      if v_taken >= v_cap then
        perform set_config('bb.skip_waitlist_offer', 'on', true);
        update public.activity_sessions set capacity = v_taken + 1 where id = p_session_id;
        perform set_config('bb.skip_waitlist_offer', 'off', true);
        v_raised := true;
      end if;
    end if;
    insert into public.bookings (session_id, guest_name, guest_contact, payment_status, status)
    values (p_session_id, btrim(p_guest_name), nullif(btrim(p_guest_contact), ''), case when p_paid then 'paid' else 'none' end, 'confirmed')
    returning id, status into v_id, v_status;
    if v_status <> 'confirmed' then
      raise exception 'Not booked. The class filled up while saving; try again.';
    end if;
    return jsonb_build_object('booking_id', v_id, 'status', v_status, 'method', 'manual', 'capacity_increased', v_raised);
  end if;

  -- ---- credit ---------------------------------------------------------------
  if p_method = 'credit' then
    if v_child is null then
      select c.id into v_child from public.children c where c.parent_id = p_user_id order by c.created_at limit 1;
    end if;
    v_before := v_pur.credits_remaining;
    insert into public.bookings (user_id, session_id, child_id, package_purchase_id, policies_accepted)
    values (p_user_id, p_session_id, v_child, p_purchase_id, '{}'::uuid[])
    returning id, status into v_id, v_status;
    if v_status = 'pending' then
      update public.bookings set status = 'confirmed' where id = v_id;
      v_status := 'confirmed';
    end if;
    if v_status <> 'confirmed' then
      raise exception 'Not booked. The class filled up while saving; no credit was used.';
    end if;
    update public.package_purchases
       set credits_remaining = credits_remaining - 1,
           status = case when credits_remaining - 1 <= 0 then 'used' else status end
     where id = p_purchase_id and credits_remaining >= 1 and status = 'active';
    get diagnostics v_n = row_count;
    select credits_remaining into v_after from public.package_purchases where id = p_purchase_id;
    -- Read-back: exactly one credit gone, and this booking points at the pack.
    if v_n <> 1 or v_after is distinct from v_before - 1
       or not exists (select 1 from public.bookings where id = v_id and package_purchase_id = p_purchase_id) then
      raise exception 'Not booked. The credit balance did not change as expected, so nothing was saved.';
    end if;
    return jsonb_build_object('booking_id', v_id, 'status', v_status, 'method', 'credit',
      'credits_before', v_before, 'credits_after', v_after);
  end if;

  -- ---- make-up token --------------------------------------------------------
  v_child := coalesce(v_tok.child_id, p_child_id);
  insert into public.bookings (user_id, session_id, child_id, policies_accepted)
  values (p_user_id, p_session_id, v_child, '{}'::uuid[])
  returning id, status into v_id, v_status;
  if v_status = 'pending' then
    -- Spend from the customer's balance with this vendor, then confirm (the confirm trigger settles it).
    v_n := round(coalesce(public.session_price(p_session_id), 0) * 100)::int;
    if coalesce((public.reserve_make_up_credit(p_user_id, v_tok.provider_id, gen_random_uuid(), 'booking',
          jsonb_build_array(jsonb_build_object('booking_id', v_id, 'cents', v_n)))->>'total')::int, 0) < v_n then
      raise exception 'Not booked. The make-up token balance did not cover the class, so nothing was saved.';
    end if;
    update public.bookings set status = 'confirmed', paid_by_credit = true where id = v_id;
    v_status := 'confirmed';
  end if;
  if v_status <> 'confirmed' then
    raise exception 'Not booked. The class filled up while saving; no make-up token was used.';
  end if;
  return jsonb_build_object('booking_id', v_id, 'status', v_status, 'method', 'token');
end;
$$;

-- The two admin functions are server-only (00270); stated again so they can never be left callable from the
-- browser, whichever order the migrations reached a database in.
revoke all on function public.admin_booking_checks(uuid, uuid, text, uuid, uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.admin_booking_checks(uuid, uuid, text, uuid, uuid, uuid, boolean) to service_role;
revoke all on function public.admin_create_booking(uuid, uuid, text, uuid, uuid, uuid, text, text, boolean, boolean) from public, anon, authenticated;
grant execute on function public.admin_create_booking(uuid, uuid, text, uuid, uuid, uuid, text, text, boolean, boolean) to service_role;

-- =============================================================
-- 12. Sweep holds that no checkout ever settled (packs, tickets: no booking row to cancel)
-- =============================================================
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'release-stale-make-up-credit-holds';
    perform cron.schedule('release-stale-make-up-credit-holds', '*/15 * * * *', 'select public.release_stale_make_up_credit_holds();');
  end if;
end $$;

notify pgrst, 'reload schema';

commit;
