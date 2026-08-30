-- 00069_wix_events.sql
--
-- Wix Events & Tickets integration — a separate Wix app/API from Bookings
-- (everything else under provider_wix_credentials), with its own scopes
-- (SCOPE.DC-EVENTS.READ-EVENTS, SCOPE.DC-EVENTS.MANAGE-TICKET-DEF,
-- SCOPE.EVENTS.EVENTS-CHECKOUT, SCOPE.DC-EVENTS.MANAGE-ORDERS) and its own
-- "Wix Events & Tickets" app install per vendor site. A vendor connected for
-- Bookings only won't have any of this data — see lib/wix/events-sync.ts.
--
-- Deliberately mirrors the activities / activity_sessions / bookings shape
-- rather than reusing those tables: an event is one-off (not a recurring
-- service+slot), and its "sessions" are ticket types with real Wix-side
-- inventory/pricing, not local capacity we materialize ourselves.
-- Idempotent.

create table if not exists public.wix_events (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references public.providers (id) on delete cascade,
  wix_event_id text not null,
  title text not null,
  slug text not null default '',
  description text not null default '',
  start_date timestamptz not null,
  end_date timestamptz not null,
  -- Events V3 returns real UTC instants (unlike the Bookings appointment
  -- time-slots endpoint, which returns site-local wall-clock strings
  -- needing wixLocalToUtcIso — see 6d88579) — stored as-is, no conversion.
  time_zone_id text,
  location_name text,
  location_type text,
  city text,
  formatted_address text,
  location_tbd boolean not null default false,
  main_image_url text,
  wix_status text not null default 'UPCOMING',
  is_published boolean not null default true,
  -- Same two-flavor "gone" tracking as activities (00063/00067): removed_at
  -- for a vendor deliberately unlinking, missing_since for a sync that can
  -- no longer find this event on the currently-connected Wix account.
  wix_removed_at timestamptz,
  wix_missing_since timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists wix_events_provider_wix_event_idx
  on public.wix_events (provider_id, wix_event_id);
create index if not exists wix_events_start_date_idx
  on public.wix_events (start_date) where wix_removed_at is null;

create table if not exists public.event_ticket_types (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.wix_events (id) on delete cascade,
  wix_ticket_definition_id text not null,
  name text not null,
  -- Wix ticket prices are per-event currency (a vendor's Wix site sets its
  -- own currency — confirmed live against a real event priced in INR on an
  -- otherwise-SGD platform), so this is NOT assumed to be SGD anywhere
  -- downstream. price_cents assumes a 2-decimal currency, same as the rest
  -- of this codebase's cents math.
  price_cents int not null default 0 check (price_cents >= 0),
  currency text not null default 'SGD',
  is_free boolean not null default false,
  -- null = unlimited, mirroring Wix's own salesDetails.unsoldCount semantics.
  capacity_total int,
  capacity_remaining int,
  limit_per_checkout int,
  sale_start_date timestamptz,
  sale_end_date timestamptz,
  sale_status text not null default 'SALE_SCHEDULED',
  hidden boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists event_ticket_types_event_wix_def_idx
  on public.event_ticket_types (event_id, wix_ticket_definition_id);

-- No local capacity/waitlist trigger like activity_sessions has — Wix's own
-- reservation (20-30 min hold, auto-released on expiry/failure) is the only
-- source of truth for whether a ticket is actually available; see
-- lib/wix/events-sync.ts and app/api/wix/events/checkout/route.ts.
create table if not exists public.event_ticket_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.parent_profiles (id) on delete cascade,
  child_id uuid references public.children (id) on delete set null,
  event_id uuid not null references public.wix_events (id),
  ticket_type_id uuid not null references public.event_ticket_types (id),
  quantity int not null default 1 check (quantity between 1 and 20),
  status text not null default 'pending'
    check (status in ('pending', 'confirmed', 'cancelled')),
  payment_status text not null default 'none'
    check (payment_status in ('none', 'paid', 'refunded')),
  -- Total actually charged, including Wix's own service fee when the ticket
  -- type is FEE_ADDED_AT_CHECKOUT — confirmed live that Wix's order total
  -- can exceed ticket price * quantity, so this is never derived from price
  -- alone. See computeWixCheckoutTotal in lib/wix/client.ts.
  amount numeric(10, 2),
  stripe_payment_intent text,
  wix_reservation_id text,
  wix_order_number text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists event_ticket_orders_user_id_idx
  on public.event_ticket_orders (user_id, created_at desc);
create index if not exists event_ticket_orders_event_id_idx
  on public.event_ticket_orders (event_id);
create index if not exists event_ticket_orders_ticket_type_id_idx
  on public.event_ticket_orders (ticket_type_id);
-- One in-flight (pending, unpaid) checkout per ticket type per user at a
-- time — prevents a double-submit from creating two Stripe sessions against
-- the same Wix reservation race. Paid/confirmed/cancelled rows are exempt
-- (a user can buy the same ticket type again later).
create unique index if not exists event_ticket_orders_one_pending_idx
  on public.event_ticket_orders (user_id, ticket_type_id)
  where status = 'pending' and payment_status = 'none';

alter table public.wix_events enable row level security;
alter table public.event_ticket_types enable row level security;
alter table public.event_ticket_orders enable row level security;

drop policy if exists "published wix events are public" on public.wix_events;
create policy "published wix events are public" on public.wix_events
  for select using (is_published and wix_removed_at is null);

drop policy if exists "ticket types of published wix events are public" on public.event_ticket_types;
create policy "ticket types of published wix events are public" on public.event_ticket_types
  for select using (
    not hidden
    and exists (
      select 1 from public.wix_events e
      where e.id = event_id and e.is_published and e.wix_removed_at is null
    )
  );

-- Read own; no client writes — same as bookings Phase 1 (00002_rls.sql).
-- Every write goes through app/api/wix/events/{rsvp,checkout} and the
-- Stripe webhook/reconcile, all using the service-role admin client.
drop policy if exists "select own wix event ticket orders" on public.event_ticket_orders;
create policy "select own wix event ticket orders" on public.event_ticket_orders
  for select using (user_id = auth.uid());

drop trigger if exists set_updated_at on public.wix_events;
create trigger set_updated_at before update on public.wix_events
  for each row execute function public.set_updated_at();
drop trigger if exists set_updated_at on public.event_ticket_types;
create trigger set_updated_at before update on public.event_ticket_types
  for each row execute function public.set_updated_at();
drop trigger if exists set_updated_at on public.event_ticket_orders;
create trigger set_updated_at before update on public.event_ticket_orders
  for each row execute function public.set_updated_at();
