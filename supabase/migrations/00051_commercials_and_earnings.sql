-- 00051_commercials_and_earnings.sql
--
-- Two things the vendor money flow was missing.
--
-- 1. BESPOKE COMMERCIAL TERMS. `subscriptions.commission_rate` already existed
--    and is per-provider, but nothing ever wrote it: every vendor sat on the
--    0.150 default, including Pro and Pay As You Go vendors whose plans are
--    advertised at 10%. It also couldn't express the rest of a real deal — a
--    flat per-booking fee, who absorbs the Stripe processing cost, or whether
--    commission applies to class packs.
--
-- 2. AN EARNINGS LEDGER. Nothing recorded what a vendor had earned, what was
--    deducted, or when it was paid out. That lived only inside Stripe (and for
--    vendors BabyBrain collects on behalf of, nowhere at all), so neither the
--    vendor nor the founder could answer "what am I owed?".
--
-- Idempotent.

-- =============================================================
-- 1. Commercial terms per provider
-- =============================================================
alter table public.subscriptions
  -- A fixed fee per paid booking, on top of (or instead of) the percentage.
  add column if not exists commission_flat_cents integer not null default 0,
  -- Who absorbs Stripe's processing fee. 'platform' is what the code did
  -- before this migration; 'vendor' matches what the pricing page advertises
  -- ("+ Stripe platform costs"). Charges stay destination charges either way,
  -- so dispute liability does NOT move to the vendor — only the cost does.
  add column if not exists fee_payer text not null default 'platform',
  -- Class packs are vendor revenue too, but the package checkout never split
  -- them. Some deals may still want packs left whole.
  add column if not exists commission_on_packages boolean not null default true;

alter table public.subscriptions drop constraint if exists subscriptions_fee_payer_check;
alter table public.subscriptions add constraint subscriptions_fee_payer_check
  check (fee_payer in ('platform', 'vendor'));

alter table public.subscriptions drop constraint if exists subscriptions_commission_rate_check;
alter table public.subscriptions add constraint subscriptions_commission_rate_check
  check (commission_rate >= 0 and commission_rate <= 0.5);

alter table public.subscriptions drop constraint if exists subscriptions_commission_flat_check;
alter table public.subscriptions add constraint subscriptions_commission_flat_check
  check (commission_flat_cents >= 0);

-- Align existing rows with the published pricing deck. Growth is 15%; Pro is
-- 10%; 'free' covers both the listing-only tier (which cannot take bookings,
-- so the rate is moot) and Pay As You Go, advertised at 10%.
-- Only touches rows still sitting on the old blanket default, so a bespoke
-- rate already negotiated by hand is left alone.
update public.subscriptions set commission_rate = 0.100
  where plan in ('free', 'pro') and commission_rate = 0.150;

-- =============================================================
-- 2. Earnings ledger — one row per money event for a provider
-- =============================================================
create table if not exists public.provider_earnings (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references public.providers (id) on delete cascade,
  source text not null check (source in ('booking', 'package')),
  booking_id uuid references public.bookings (id) on delete set null,
  package_purchase_id uuid references public.package_purchases (id) on delete set null,

  currency text not null default 'sgd',
  gross_cents integer not null,                    -- what the parent paid
  commission_cents integer not null default 0,     -- BabyBrain's cut
  -- Stripe's actual processing fee, read back off the balance transaction.
  -- Null until that settles (PayNow and cards settle at different speeds).
  stripe_fee_cents integer,
  net_cents integer not null,                      -- what the vendor gets

  -- The deal as it stood at the moment of sale. Stamped, not looked up later,
  -- so renegotiating a rate never rewrites past earnings.
  commission_rate numeric(4,3) not null,
  commission_flat_cents integer not null default 0,
  fee_payer text not null check (fee_payer in ('platform', 'vendor')),

  -- Whether the money actually went to the vendor's own Stripe account. False
  -- means BabyBrain collected it and owes the vendor directly.
  routed_to_connect boolean not null default false,

  stripe_payment_intent text,
  stripe_transfer_id text,
  stripe_payout_id text,
  paid_out_at timestamptz,

  status text not null default 'pending'
    check (status in ('pending', 'in_transit', 'paid_out', 'platform_owed', 'refunded')),
  created_at timestamptz not null default now()
);

comment on table public.provider_earnings is
  'Per-sale ledger of what a provider earned, what was deducted and when Stripe paid it out. Written only by the service role (Stripe webhook / reconcile).';

-- One earning per payment. The Stripe webhook and /api/stripe/reconcile both
-- process the same checkout, so this is what stops a double entry.
create unique index if not exists provider_earnings_payment_intent_key
  on public.provider_earnings (stripe_payment_intent)
  where stripe_payment_intent is not null;

create index if not exists provider_earnings_provider_idx
  on public.provider_earnings (provider_id, created_at desc);
create index if not exists provider_earnings_transfer_idx
  on public.provider_earnings (stripe_transfer_id)
  where stripe_transfer_id is not null;
create index if not exists provider_earnings_payout_idx
  on public.provider_earnings (stripe_payout_id)
  where stripe_payout_id is not null;
-- Drives "what's still owed" without scanning the vendor's whole history.
create index if not exists provider_earnings_unpaid_idx
  on public.provider_earnings (provider_id, status)
  where status in ('pending', 'in_transit', 'platform_owed');

alter table public.provider_earnings enable row level security;

-- Members read their own business's earnings; nobody writes from the client.
drop policy if exists "members read earnings" on public.provider_earnings;
create policy "members read earnings" on public.provider_earnings
  for select using (provider_id in (select user_provider_ids()));
