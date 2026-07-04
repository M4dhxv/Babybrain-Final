-- BabyBrain — class packages (multi-session packs) + purchase tracking.
--   packages          : vendor-defined pack (N credits for a price).
--   package_purchases : a parent's bought pack with remaining credits.
-- Booking against a pack consumes one credit via redeem_package_credit()
-- (parents can't write purchases directly — only the Stripe webhook/service
-- role and the SECURITY DEFINER redeem function). Idempotent.

create table if not exists public.packages (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references public.providers (id) on delete cascade,
  activity_id uuid references public.activities (id) on delete set null, -- null → any of the provider's classes
  name text not null,
  credits int not null check (credits > 0),
  price_cents int not null check (price_cents >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists packages_provider_idx on public.packages (provider_id, active);

create table if not exists public.package_purchases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.parent_profiles (id) on delete cascade,
  package_id uuid not null references public.packages (id) on delete restrict,
  provider_id uuid not null references public.providers (id) on delete cascade,
  credits_total int not null,
  credits_remaining int not null,
  status text not null default 'active' check (status in ('active', 'used', 'expired')),
  stripe_payment_intent text,
  created_at timestamptz not null default now(),
  expires_at timestamptz
);
create index if not exists package_purchases_user_idx on public.package_purchases (user_id, status);

alter table public.packages enable row level security;
alter table public.package_purchases enable row level security;

-- packages: anyone may read active packs; vendor members manage their own.
drop policy if exists "read active packages" on public.packages;
create policy "read active packages" on public.packages
  for select using (active or provider_id in (select public.user_provider_ids()));
drop policy if exists "members manage packages" on public.packages;
create policy "members manage packages" on public.packages
  for all using (provider_id in (select public.user_provider_ids()))
  with check (provider_id in (select public.user_provider_ids()));

-- package_purchases: parent reads own; all writes via service role / definer fn.
drop policy if exists "read own purchases" on public.package_purchases;
create policy "read own purchases" on public.package_purchases
  for select using (user_id = auth.uid());
drop policy if exists "members read provider purchases" on public.package_purchases;
create policy "members read provider purchases" on public.package_purchases
  for select using (provider_id in (select public.user_provider_ids()));

-- Consume one credit from a purchase to book a session, atomically.
create or replace function public.redeem_package_credit(p_purchase_id uuid, p_session_id uuid)
returns text
language plpgsql
security definer set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_pur public.package_purchases;
  v_pkg public.packages;
  v_session_activity uuid;
  v_session_provider uuid;
  v_booking_id uuid;
  v_status text;
begin
  if v_user is null then
    raise exception 'Not authenticated';
  end if;

  select * into v_pur
  from public.package_purchases
  where id = p_purchase_id
    and user_id = v_user
    and status = 'active'
    and credits_remaining > 0
    and (expires_at is null or expires_at > now());
  if not found then
    raise exception 'No credits available on this package';
  end if;

  select * into v_pkg from public.packages where id = v_pur.package_id;

  select s.activity_id, a.provider_id into v_session_activity, v_session_provider
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  where s.id = p_session_id;

  if v_session_provider is null or v_session_provider <> v_pur.provider_id then
    raise exception 'This package can only be used for its provider''s classes';
  end if;
  if v_pkg.activity_id is not null and v_pkg.activity_id <> v_session_activity then
    raise exception 'This package is limited to a specific class';
  end if;

  insert into public.bookings (user_id, session_id, child_id)
  values (v_user, p_session_id, null)
  returning id, status into v_booking_id, v_status;

  update public.package_purchases
  set credits_remaining = credits_remaining - 1,
      status = case when credits_remaining - 1 <= 0 then 'used' else status end
  where id = p_purchase_id;

  return v_status;
end;
$$;

grant execute on function public.redeem_package_credit(uuid, uuid) to authenticated;
