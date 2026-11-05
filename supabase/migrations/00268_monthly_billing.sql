-- 00268_monthly_billing.sql
--
-- Monthly billing: a vendor can switch an activity to "billed monthly". A parent enrols once,
-- books any number of sessions through the ordinary booking flow, pays nothing at booking time,
-- and is invoiced on the 1st of the next month for the sessions they had in the month just ended
-- (post-paid). The invoice is due by the end of the 5th. A parent who has not paid by then cannot
-- book more sessions in that activity until it is cleared. Leaving takes 14 days' notice.
--
-- Design — monthly billing is NOT a second booking system (same idea as terms, 00256):
--   * Sessions stay ordinary activity_sessions and seats stay ordinary bookings rows, so the
--     roster, calendar, attendance, reminders, cancellation, capacity and waitlist keep working.
--   * monthly_billing_gate (a BEFORE INSERT trigger on bookings, after booking_insert_defaults)
--     recognises a parent's booking on a monthly activity: it requires an enrolment that is not
--     past its end date, refuses while an invoice for that activity is overdue, and confirms the
--     seat at once instead of leaving it 'pending' for Stripe. Vendor manual bookings and the
--     service role (Stripe webhook) are left alone.
--   * monthly_enrolments   one parent in one activity. 'active' -> 'ending' (notice given, still
--                          running until ends_at) -> 'ended'.
--   * monthly_invoices     one invoice per enrolment per billed month. 'open' -> 'paid' | 'void'.
--                          "Overdue" is not a status: it is an open invoice whose due_at has passed,
--                          so nothing has to run for the block to take effect on time.
--   * bookings gain monthly_enrolment_id / monthly_invoice_id. The per-seat price is stamped into
--     bookings.amount when the invoice is issued, from session_price() as of that moment.
--
-- Rules (all Singapore time):
--   * Invoice for month M is issued on the 1st of M+1 by monthly_billing_daily() (pg_cron 09:00).
--     It covers every seat that is not cancelled / waitlisted / pending on a session starting in M.
--     A missed run catches up the next day. Seats on a free session cost nothing and are not billed.
--   * due_at = 00:00 on the 6th, i.e. the whole of the 5th is still "on time". An invoice issued
--     late (after the 5th) is due 5 days after it was issued.
--   * Notice: giving notice on day D ends the enrolment after D+14 (ends_at = 00:00 on D+15).
--     Sessions up to then can still be booked and are billed; seats booked after that are cancelled
--     at once. Notice can be withdrawn until ends_at.
--   * Overdue also blocks a fresh enrolment in the same activity, so leaving and re-joining is not a
--     way round it.
--
-- Not covered (deliberately, decide before building): vendor-side ending of an enrolment, late fees,
-- charging no-shows differently, a flat monthly price, enrolling one child rather than the family,
-- Wix-linked activities (refused), and package credits (refused on a monthly activity).
--
-- Idempotent.

begin;

-- =============================================================
-- 1. Tables and columns
-- =============================================================
alter table public.activities
  add column if not exists monthly_billing_enabled boolean not null default false;

comment on column public.activities.monthly_billing_enabled is
  'Parents enrol once and are invoiced monthly in arrears (00268) instead of paying per booking.';

create table if not exists public.monthly_enrolments (
  id                 uuid primary key default gen_random_uuid(),
  provider_id        uuid not null references public.providers (id) on delete cascade,
  activity_id        uuid not null references public.activities (id) on delete restrict,
  user_id            uuid not null references public.parent_profiles (id) on delete cascade,
  status             text not null default 'active' check (status in ('active', 'ending', 'ended')),
  enrolled_at        timestamptz not null default now(),
  -- Set when notice is given. ends_at is exclusive: nothing starting at or after it is allowed.
  cancel_requested_at timestamptz,
  ends_at            timestamptz,
  ended_at           timestamptz,
  created_at         timestamptz not null default now(),
  constraint monthly_enrolments_notice_ck check ((status = 'active') = (ends_at is null) or status = 'ended')
);
create unique index if not exists monthly_enrolments_one_live_idx
  on public.monthly_enrolments (user_id, activity_id) where status in ('active', 'ending');
create index if not exists monthly_enrolments_provider_idx on public.monthly_enrolments (provider_id, status);
create index if not exists monthly_enrolments_activity_idx on public.monthly_enrolments (activity_id, status);
create index if not exists monthly_enrolments_user_idx on public.monthly_enrolments (user_id, created_at desc);

create table if not exists public.monthly_invoices (
  id                 uuid primary key default gen_random_uuid(),
  enrolment_id       uuid not null references public.monthly_enrolments (id) on delete restrict,
  provider_id        uuid not null references public.providers (id) on delete cascade,
  activity_id        uuid not null references public.activities (id) on delete restrict,
  user_id            uuid not null references public.parent_profiles (id) on delete cascade,
  -- First day of the month the sessions were in (Singapore).
  period_start       date not null,
  session_count      int  not null check (session_count >= 1),
  amount_cents       int  not null check (amount_cents > 0),
  status             text not null default 'open' check (status in ('open', 'paid', 'void')),
  issued_at          timestamptz not null default now(),
  due_at             timestamptz not null,
  paid_at            timestamptz,
  -- A vendor settled it outside the app (bank transfer, cash) or waived it.
  settled_by         uuid references auth.users (id) on delete set null,
  settle_note        text,
  paid_manually      boolean not null default false,
  stripe_checkout_session_id text,
  stripe_payment_intent text,
  reminder_sent_at   timestamptz,
  overdue_notified_at timestamptz,
  created_at         timestamptz not null default now()
);
create index if not exists monthly_invoices_user_idx on public.monthly_invoices (user_id, status, due_at);
create index if not exists monthly_invoices_provider_idx on public.monthly_invoices (provider_id, status, due_at);
create index if not exists monthly_invoices_enrolment_idx on public.monthly_invoices (enrolment_id, period_start);
create unique index if not exists monthly_invoices_payment_intent_idx
  on public.monthly_invoices (stripe_payment_intent) where stripe_payment_intent is not null;

alter table public.bookings
  add column if not exists monthly_enrolment_id uuid references public.monthly_enrolments (id) on delete set null,
  add column if not exists monthly_invoice_id uuid references public.monthly_invoices (id) on delete set null;
create index if not exists bookings_monthly_enrolment_idx
  on public.bookings (monthly_enrolment_id) where monthly_enrolment_id is not null;
create index if not exists bookings_monthly_invoice_idx
  on public.bookings (monthly_invoice_id) where monthly_invoice_id is not null;

-- Earnings ledger: a paid invoice is a third kind of sale.
alter table public.provider_earnings
  add column if not exists monthly_invoice_id uuid references public.monthly_invoices (id) on delete set null;
alter table public.provider_earnings drop constraint if exists provider_earnings_source_check;
alter table public.provider_earnings
  add constraint provider_earnings_source_check check (source in ('booking', 'package', 'monthly'));

-- =============================================================
-- 2. RLS — a parent reads their own, a vendor reads their provider's. Writes go through the
--    functions below only.
-- =============================================================
alter table public.monthly_enrolments enable row level security;
alter table public.monthly_invoices enable row level security;

drop policy if exists "read own monthly enrolments" on public.monthly_enrolments;
create policy "read own monthly enrolments" on public.monthly_enrolments
  for select using (user_id = auth.uid());
drop policy if exists "members read monthly enrolments" on public.monthly_enrolments;
create policy "members read monthly enrolments" on public.monthly_enrolments
  for select using (provider_id in (select public.user_provider_ids()));

drop policy if exists "read own monthly invoices" on public.monthly_invoices;
create policy "read own monthly invoices" on public.monthly_invoices
  for select using (user_id = auth.uid());
drop policy if exists "members read monthly invoices" on public.monthly_invoices;
create policy "members read monthly invoices" on public.monthly_invoices
  for select using (provider_id in (select public.user_provider_ids()));

-- =============================================================
-- 3. The switch: only on a native activity, never alongside terms, and not off under live billing
-- =============================================================
create or replace function public.guard_monthly_billing_enabled()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  j jsonb := to_jsonb(new);
begin
  if tg_op = 'UPDATE' then
    if old.monthly_billing_enabled and not new.monthly_billing_enabled then
      if exists (select 1 from public.monthly_enrolments e where e.activity_id = new.id and e.status in ('active', 'ending'))
         or exists (select 1 from public.monthly_invoices i where i.activity_id = new.id and i.status = 'open') then
        raise exception 'Parents are still enrolled or owe an invoice for this activity. Let those finish before turning monthly billing off.';
      end if;
    end if;
    if old.monthly_billing_enabled then
      return new;                     -- already on: nothing more to check
    end if;
  end if;
  if new.monthly_billing_enabled then
    if coalesce(j ->> 'wix_service_id', '') <> '' or coalesce(j ->> 'wix_event_id', '') <> ''
       or coalesce(j ->> 'wix_service_type', '') <> '' then
      raise exception 'Monthly billing is not available for classes synced from Wix.';
    end if;
    if coalesce(j ->> 'terms_enabled', 'false') = 'true' then
      raise exception 'Turn terms off for this activity before switching on monthly billing.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists activities_monthly_billing_guard on public.activities;
create trigger activities_monthly_billing_guard
  before insert or update of monthly_billing_enabled on public.activities
  for each row execute function public.guard_monthly_billing_enabled();

-- And the other way round: terms cannot be switched on under a monthly activity.
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'activities' and column_name = 'terms_enabled') then
    alter table public.activities drop constraint if exists activities_not_terms_and_monthly;
    alter table public.activities
      add constraint activities_not_terms_and_monthly check (not (terms_enabled and monthly_billing_enabled)) not valid;
  end if;
end $$;

-- =============================================================
-- 4. Helpers
-- =============================================================
-- "SGD 123.00"
create or replace function public.monthly_money(p_cents int)
returns text
language sql
immutable
as $$ select 'SGD ' || to_char(p_cents / 100.0, 'FM999,999,990.00') $$;

-- The last day a parent on notice may still attend, as a date.
create or replace function public.monthly_last_day(p_ends_at timestamptz)
returns date
language sql
immutable
as $$ select ((p_ends_at at time zone 'Asia/Singapore')::date - 1) $$;

create or replace function public.monthly_has_overdue(p_user uuid, p_activity uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (
    select 1 from public.monthly_invoices i
    where i.user_id = p_user and i.activity_id = p_activity
      and i.status = 'open' and i.due_at <= now()
  );
$$;

create or replace function public.monthly_notify_vendor(
  p_provider uuid, p_type text, p_title text, p_body text, p_data jsonb
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  insert into public.notifications (user_id, type, title, body, data)
  select m.user_id, p_type, p_title, p_body, p_data
  from public.provider_members m
  where m.provider_id = p_provider and m.status = 'active';
end;
$$;

-- =============================================================
-- 5. The booking gate
-- =============================================================
create or replace function public.monthly_billing_gate()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_enabled  boolean;
  v_title    text;
  v_provider uuid;
  v_activity uuid;
  v_starts   timestamptz;
  v_enrol    public.monthly_enrolments;
begin
  select a.monthly_billing_enabled, a.title, a.provider_id, a.id, s.starts_at
    into v_enabled, v_title, v_provider, v_activity, v_starts
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  where s.id = new.session_id;
  if not found or not coalesce(v_enabled, false) then
    return new;                       -- an ordinary session: not our business
  end if;
  if coalesce(auth.role(), '') = 'service_role' then
    return new;                       -- trusted server paths
  end if;
  if v_provider in (select public.user_manage_provider_ids()) then
    return new;                       -- a vendor adding their own manual booking
  end if;
  if new.user_id is null then
    return new;
  end if;

  if new.package_purchase_id is not null then
    raise exception '% is billed monthly, so package credits can''t be used for it.', v_title;
  end if;

  select e.* into v_enrol
  from public.monthly_enrolments e
  where e.user_id = new.user_id and e.activity_id = v_activity and e.status in ('active', 'ending')
  limit 1;
  if not found then
    raise exception '% is billed monthly. Enrol first, then book your sessions.', v_title;
  end if;

  if public.monthly_has_overdue(new.user_id, v_activity) then
    raise exception 'You have an overdue monthly payment for %. Please pay it before booking more sessions.', v_title;
  end if;

  if v_enrol.status = 'ending' and v_starts >= v_enrol.ends_at then
    raise exception 'Your enrolment in % ends on %, so you can''t book sessions after that.',
      v_title, to_char(public.monthly_last_day(v_enrol.ends_at), 'FMDD Mon YYYY');
  end if;

  new.monthly_enrolment_id := v_enrol.id;
  -- Nothing to pay at booking time: a seat that would have waited for Stripe is simply confirmed.
  if new.status = 'pending' then
    new.status := 'confirmed';
  end if;
  new.payment_status := 'none';
  return new;
end;
$$;

-- Named to sort after booking_insert_defaults, which is what leaves a priced seat 'pending'.
drop trigger if exists monthly_billing_gate on public.bookings;
create trigger monthly_billing_gate before insert on public.bookings
  for each row execute function public.monthly_billing_gate();

-- =============================================================
-- 6. Parent: enrol, give notice, take notice back
-- =============================================================
create or replace function public.monthly_enrol(p_activity_id uuid)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_user uuid := auth.uid();
  v_act  public.activities;
  v_e    public.monthly_enrolments;
  v_id   uuid;
begin
  if v_user is null then
    raise exception 'Please log in first.';
  end if;
  select a.* into v_act from public.activities a where a.id = p_activity_id;
  if not found or not v_act.monthly_billing_enabled then
    raise exception 'This class is not billed monthly.';
  end if;
  if exists (select 1 from public.providers p where p.id = v_act.provider_id and p.status <> 'active') then
    raise exception 'This provider is not currently taking bookings.';
  end if;

  select e.* into v_e from public.monthly_enrolments e
   where e.user_id = v_user and e.activity_id = p_activity_id and e.status in ('active', 'ending');
  if found then
    if v_e.status = 'ending' then
      raise exception 'Your enrolment in % ends on %. Take your notice back if you would like to stay.',
        v_act.title, to_char(public.monthly_last_day(v_e.ends_at), 'FMDD Mon YYYY');
    end if;
    return v_e.id;                    -- already enrolled
  end if;

  if public.monthly_has_overdue(v_user, p_activity_id) then
    raise exception 'You have an overdue monthly payment for %. Please pay it before enrolling again.', v_act.title;
  end if;

  insert into public.monthly_enrolments (provider_id, activity_id, user_id)
  values (v_act.provider_id, p_activity_id, v_user)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.monthly_give_notice(p_enrolment_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_user uuid := auth.uid();
  v_e    public.monthly_enrolments;
  v_ends timestamptz;
  v_title text;
  v_who  text;
  v_name text;
  v_cancelled int;
begin
  select e.* into v_e from public.monthly_enrolments e
   where e.id = p_enrolment_id and e.user_id = v_user for update;
  if not found then
    raise exception 'That enrolment does not exist.';
  end if;
  if v_e.status = 'ending' then
    raise exception 'You have already given notice.';
  end if;
  if v_e.status <> 'active' then
    raise exception 'This enrolment has already ended.';
  end if;

  -- 14 days' notice: today plus 14 more days are still the parent's; the enrolment ends after that.
  v_ends := (((now() at time zone 'Asia/Singapore')::date + 15)::timestamp at time zone 'Asia/Singapore');

  update public.monthly_enrolments
     set status = 'ending', cancel_requested_at = now(), ends_at = v_ends
   where id = v_e.id;

  -- Seats already booked beyond the notice period are released (nothing was charged for them).
  with gone as (
    update public.bookings b
       set status = 'cancelled', cancel_refund_mode = 'none',
           cancel_reason = 'Monthly enrolment ended'
      from public.activity_sessions s
     where s.id = b.session_id
       and b.monthly_enrolment_id = v_e.id
       and b.status in ('pending', 'confirmed', 'waitlisted')
       and s.starts_at >= v_ends
    returning b.id
  )
  select count(*)::int into v_cancelled from gone;

  select a.title into v_title from public.activities a where a.id = v_e.activity_id;
  select coalesce(nullif(btrim(p.business_name), ''), 'The provider') into v_who
    from public.providers p where p.id = v_e.provider_id;
  select coalesce(nullif(btrim(pp.full_name), ''), 'A parent') into v_name
    from public.parent_profiles pp where pp.id = v_user;

  insert into public.notifications (user_id, type, title, body, data)
  values (
    v_user, 'monthly_notice_given', 'We have your notice for ' || v_title,
    'Your last day in ' || v_title || ' with ' || v_who || ' is '
      || to_char(public.monthly_last_day(v_ends), 'FMDay FMDD Mon YYYY')
      || '. Sessions up to then are billed as usual; your final invoice arrives on the 1st.'
      || case when v_cancelled > 0
              then ' ' || v_cancelled || ' session' || case when v_cancelled = 1 then '' else 's' end
                   || ' booked after that date ' || case when v_cancelled = 1 then 'was' else 'were' end || ' cancelled.'
              else '' end,
    jsonb_build_object('url', '/profile?tab=monthly', 'activity_name', v_title, 'provider_name', v_who,
                       'last_day', to_char(public.monthly_last_day(v_ends), 'FMDD Mon YYYY'),
                       'cancelled_sessions', v_cancelled, 'enrolment_id', v_e.id)
  );
  perform public.monthly_notify_vendor(
    v_e.provider_id, 'provider_monthly_notice_given', v_name || ' is leaving ' || v_title,
    v_name || ' has given 14 days'' notice for ' || v_title || '. Their last day is '
      || to_char(public.monthly_last_day(v_ends), 'FMDay FMDD Mon YYYY') || '.',
    jsonb_build_object('url', '/vendor/#/monthly-billing', 'activity_name', v_title, 'parent_name', v_name,
                       'last_day', to_char(public.monthly_last_day(v_ends), 'FMDD Mon YYYY'))
  );
  return v_ends;
end;
$$;

create or replace function public.monthly_withdraw_notice(p_enrolment_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_e public.monthly_enrolments;
begin
  select e.* into v_e from public.monthly_enrolments e
   where e.id = p_enrolment_id and e.user_id = auth.uid() for update;
  if not found then
    raise exception 'That enrolment does not exist.';
  end if;
  if v_e.status <> 'ending' or v_e.ends_at <= now() then
    raise exception 'There is no notice to take back.';
  end if;
  update public.monthly_enrolments
     set status = 'active', cancel_requested_at = null, ends_at = null
   where id = v_e.id;
end;
$$;

-- =============================================================
-- 7. What a parent has booked but not yet been invoiced for
-- =============================================================
create or replace function public.monthly_unbilled(p_enrolment_id uuid)
returns table (period_start date, sessions int, amount_cents int)
language sql
stable
security definer
set search_path to 'public'
as $$
  select date_trunc('month', s.starts_at at time zone 'Asia/Singapore')::date as period_start,
         count(*)::int as sessions,
         coalesce(sum(round(coalesce(b.amount, public.session_price(b.session_id), 0) * 100)), 0)::int as amount_cents
  from public.monthly_enrolments e
  join public.bookings b on b.monthly_enrolment_id = e.id
  join public.activity_sessions s on s.id = b.session_id
  where e.id = p_enrolment_id
    and (e.user_id = auth.uid() or e.provider_id in (select public.user_provider_ids()))
    and b.monthly_invoice_id is null
    and b.status not in ('cancelled', 'waitlisted', 'pending')
    and coalesce(b.amount, public.session_price(b.session_id), 0) > 0
  group by 1
  order by 1;
$$;

-- =============================================================
-- 8. Vendor: settle an invoice outside the app, or waive it
-- =============================================================
create or replace function public.monthly_settle_invoice(p_invoice_id uuid, p_action text, p_note text default null)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_i public.monthly_invoices;
begin
  if p_action not in ('paid', 'void') then
    raise exception 'Unknown action.';
  end if;
  select i.* into v_i from public.monthly_invoices i where i.id = p_invoice_id for update;
  if not found or v_i.provider_id not in (select public.user_manage_provider_ids()) then
    raise exception 'That invoice does not exist.';
  end if;
  if v_i.status <> 'open' then
    raise exception 'This invoice is already %.', v_i.status;
  end if;

  update public.monthly_invoices
     set status = case p_action when 'paid' then 'paid' else 'void' end,
         paid_at = case p_action when 'paid' then now() else null end,
         paid_manually = (p_action = 'paid'),
         settled_by = auth.uid(),
         settle_note = nullif(btrim(p_note), '')
   where id = v_i.id;
  if p_action = 'paid' then
    update public.bookings set payment_status = 'paid' where monthly_invoice_id = v_i.id;
  end if;
end;
$$;

-- =============================================================
-- 8b. Vendor: who is enrolled and what they owe (parent names are not readable under RLS)
-- =============================================================
create or replace function public.monthly_provider_enrolments(p_provider uuid)
returns table (
  enrolment_id uuid, activity_id uuid, activity_title text, user_id uuid,
  parent_name text, parent_email text, status text, enrolled_at timestamptz, ends_at timestamptz,
  unbilled_sessions int, unbilled_cents int, open_cents int, overdue_cents int
)
language sql
stable
security definer
set search_path to 'public'
as $$
  select e.id, e.activity_id, a.title, e.user_id,
         coalesce(nullif(btrim(pp.full_name), ''), 'Parent'), pp.email, e.status, e.enrolled_at, e.ends_at,
         coalesce(u.n, 0), coalesce(u.cents, 0),
         coalesce(o.open_cents, 0), coalesce(o.overdue_cents, 0)
  from public.monthly_enrolments e
  join public.activities a on a.id = e.activity_id
  left join public.parent_profiles pp on pp.id = e.user_id
  left join lateral (
    select count(*)::int as n,
           coalesce(sum(round(coalesce(b.amount, public.session_price(b.session_id), 0) * 100)), 0)::int as cents
    from public.bookings b
    where b.monthly_enrolment_id = e.id and b.monthly_invoice_id is null
      and b.status not in ('cancelled', 'waitlisted', 'pending')
      and coalesce(b.amount, public.session_price(b.session_id), 0) > 0
  ) u on true
  left join lateral (
    select coalesce(sum(i.amount_cents), 0)::int as open_cents,
           coalesce(sum(i.amount_cents) filter (where i.due_at <= now()), 0)::int as overdue_cents
    from public.monthly_invoices i where i.enrolment_id = e.id and i.status = 'open'
  ) o on true
  where e.provider_id = p_provider
    and p_provider in (select public.user_provider_ids())
  order by (e.status = 'ended'), a.title, pp.full_name;
$$;

create or replace function public.monthly_provider_invoices(p_provider uuid)
returns table (
  invoice_id uuid, enrolment_id uuid, activity_id uuid, activity_title text, user_id uuid,
  parent_name text, parent_email text, period_start date, session_count int, amount_cents int,
  status text, issued_at timestamptz, due_at timestamptz, paid_at timestamptz, paid_manually boolean,
  overdue boolean, settle_note text
)
language sql
stable
security definer
set search_path to 'public'
as $$
  select i.id, i.enrolment_id, i.activity_id, a.title, i.user_id,
         coalesce(nullif(btrim(pp.full_name), ''), 'Parent'), pp.email, i.period_start, i.session_count,
         i.amount_cents, i.status, i.issued_at, i.due_at, i.paid_at, i.paid_manually,
         (i.status = 'open' and i.due_at <= now()), i.settle_note
  from public.monthly_invoices i
  join public.activities a on a.id = i.activity_id
  left join public.parent_profiles pp on pp.id = i.user_id
  where i.provider_id = p_provider
    and p_provider in (select public.user_provider_ids())
  order by (i.status = 'open') desc, i.due_at desc, i.created_at desc;
$$;

-- =============================================================
-- 9. Stripe: a paid invoice (called by the webhook / reconcile, service role only)
-- =============================================================
-- Returns true when this call is the one that marked it paid, false when it already was.
create or replace function public.monthly_mark_invoice_paid(
  p_invoice_id uuid, p_payment_intent text, p_checkout_session text
)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_i public.monthly_invoices;
  v_title text;
begin
  select i.* into v_i from public.monthly_invoices i where i.id = p_invoice_id for update;
  if not found then
    raise exception 'Invoice not found';
  end if;
  if v_i.status = 'paid' then
    return false;
  end if;
  -- A payment that lands after a vendor waived the invoice is still money received; record it paid.
  update public.monthly_invoices
     set status = 'paid', paid_at = now(), stripe_payment_intent = p_payment_intent,
         stripe_checkout_session_id = coalesce(p_checkout_session, stripe_checkout_session_id)
   where id = v_i.id;
  update public.bookings
     set payment_status = 'paid', stripe_payment_intent = p_payment_intent
   where monthly_invoice_id = v_i.id;

  select a.title into v_title from public.activities a where a.id = v_i.activity_id;
  insert into public.notifications (user_id, type, title, body, data)
  values (
    v_i.user_id, 'monthly_invoice_paid', 'Payment received — thank you',
    'We have received ' || public.monthly_money(v_i.amount_cents) || ' for ' || v_title || ' ('
      || to_char(v_i.period_start, 'FMMonth YYYY') || ').',
    jsonb_build_object('url', '/profile?tab=monthly', 'activity_name', v_title,
                       'month', to_char(v_i.period_start, 'FMMonth YYYY'),
                       'amount', public.monthly_money(v_i.amount_cents), 'invoice_id', v_i.id)
  );
  return true;
end;
$$;

-- =============================================================
-- 10. The daily run: end enrolments, issue invoices, remind, flag overdue
-- =============================================================
create or replace function public.monthly_billing_daily()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_cur     date := date_trunc('month', now() at time zone 'Asia/Singapore')::date;
  v_due     timestamptz;
  r         record;
  v_id      uuid;
  v_issued  int := 0;
  v_reminded int := 0;
  v_overdue int := 0;
  v_ended   int := 0;
  v_title   text;
  v_who     text;
  v_name    text;
begin
  v_due := ((v_cur + 5)::timestamp at time zone 'Asia/Singapore');   -- 00:00 on the 6th
  if v_due <= now() then
    v_due := now() + interval '5 days';                                -- a late run still gives 5 days
  end if;

  -- 10a. Notice served: the enrolment ends.
  for r in
    update public.monthly_enrolments e
       set status = 'ended', ended_at = e.ends_at
     where e.status = 'ending' and e.ends_at <= now()
    returning e.id, e.user_id, e.activity_id, e.provider_id
  loop
    v_ended := v_ended + 1;
    select a.title into v_title from public.activities a where a.id = r.activity_id;
    insert into public.notifications (user_id, type, title, body, data)
    values (
      r.user_id, 'monthly_enrolment_ended', 'Your enrolment in ' || v_title || ' has ended',
      'Thank you for being part of ' || v_title || '. Any sessions you attended this month are on your final invoice, issued on the 1st.',
      jsonb_build_object('url', '/profile?tab=monthly', 'activity_name', v_title)
    );
  end loop;

  -- 10b. Price every seat that has been and gone, then group them into invoices.
  update public.bookings b
     set amount = coalesce(public.session_price(b.session_id), 0)
    from public.activity_sessions s
   where s.id = b.session_id
     and b.monthly_enrolment_id is not null and b.monthly_invoice_id is null and b.amount is null
     and b.status not in ('cancelled', 'waitlisted', 'pending')
     and date_trunc('month', s.starts_at at time zone 'Asia/Singapore')::date < v_cur;

  for r in
    select b.monthly_enrolment_id as enrolment_id,
           date_trunc('month', s.starts_at at time zone 'Asia/Singapore')::date as period_start,
           count(*)::int as n,
           sum(round(b.amount * 100))::int as cents
      from public.bookings b
      join public.activity_sessions s on s.id = b.session_id
     where b.monthly_enrolment_id is not null and b.monthly_invoice_id is null
       and b.amount is not null and b.amount > 0
       and b.status not in ('cancelled', 'waitlisted', 'pending')
       and date_trunc('month', s.starts_at at time zone 'Asia/Singapore')::date < v_cur
     group by 1, 2
     order by 2
  loop
    insert into public.monthly_invoices
      (enrolment_id, provider_id, activity_id, user_id, period_start, session_count, amount_cents, due_at)
    select e.id, e.provider_id, e.activity_id, e.user_id, r.period_start, r.n, r.cents, v_due
      from public.monthly_enrolments e where e.id = r.enrolment_id
    returning id into v_id;

    update public.bookings b
       set monthly_invoice_id = v_id
      from public.activity_sessions s
     where s.id = b.session_id
       and b.monthly_enrolment_id = r.enrolment_id and b.monthly_invoice_id is null
       and b.amount is not null and b.amount > 0
       and b.status not in ('cancelled', 'waitlisted', 'pending')
       and date_trunc('month', s.starts_at at time zone 'Asia/Singapore')::date = r.period_start;

    v_issued := v_issued + 1;
    select a.title, coalesce(nullif(btrim(p.business_name), ''), 'The provider')
      into v_title, v_who
      from public.monthly_invoices i
      join public.activities a on a.id = i.activity_id
      join public.providers p on p.id = i.provider_id
     where i.id = v_id;
    insert into public.notifications (user_id, type, title, body, data)
    select i.user_id, 'monthly_invoice_issued',
           'Your ' || to_char(i.period_start, 'FMMonth') || ' invoice for ' || v_title || ' is ready',
           public.monthly_money(i.amount_cents) || ' for ' || i.session_count || ' session'
             || case when i.session_count = 1 then '' else 's' end || ' in ' || to_char(i.period_start, 'FMMonth YYYY')
             || ' with ' || v_who || '. Please pay by the end of '
             || to_char((i.due_at at time zone 'Asia/Singapore')::date - 1, 'FMDay FMDD Mon') || '.',
           jsonb_build_object('url', '/profile?tab=monthly', 'invoice_id', i.id, 'activity_name', v_title,
                              'provider_name', v_who, 'month', to_char(i.period_start, 'FMMonth YYYY'),
                              'amount', public.monthly_money(i.amount_cents), 'sessions', i.session_count,
                              'due_date', to_char((i.due_at at time zone 'Asia/Singapore')::date - 1, 'FMDay FMDD Mon'))
      from public.monthly_invoices i where i.id = v_id;
  end loop;

  -- 10c. Two days before the deadline: a reminder.
  for r in
    select i.id, i.user_id, i.amount_cents, i.period_start, i.due_at, a.title
      from public.monthly_invoices i join public.activities a on a.id = i.activity_id
     where i.status = 'open' and i.reminder_sent_at is null
       and i.due_at > now() and i.due_at - interval '2 days' <= now()
  loop
    update public.monthly_invoices set reminder_sent_at = now() where id = r.id;
    v_reminded := v_reminded + 1;
    insert into public.notifications (user_id, type, title, body, data)
    values (
      r.user_id, 'monthly_invoice_reminder', 'Payment due soon: ' || r.title,
      'Your ' || to_char(r.period_start, 'FMMonth') || ' invoice of ' || public.monthly_money(r.amount_cents)
        || ' is due by the end of ' || to_char((r.due_at at time zone 'Asia/Singapore')::date - 1, 'FMDay FMDD Mon')
        || '. After that you will not be able to book more sessions until it is paid.',
      jsonb_build_object('url', '/profile?tab=monthly', 'invoice_id', r.id, 'activity_name', r.title,
                         'month', to_char(r.period_start, 'FMMonth YYYY'),
                         'amount', public.monthly_money(r.amount_cents),
                         'due_date', to_char((r.due_at at time zone 'Asia/Singapore')::date - 1, 'FMDay FMDD Mon'))
    );
  end loop;

  -- 10d. Past the deadline: tell the parent, and the vendor.
  for r in
    select i.id, i.user_id, i.provider_id, i.amount_cents, i.period_start, a.title
      from public.monthly_invoices i join public.activities a on a.id = i.activity_id
     where i.status = 'open' and i.overdue_notified_at is null and i.due_at <= now()
  loop
    update public.monthly_invoices set overdue_notified_at = now() where id = r.id;
    v_overdue := v_overdue + 1;
    select coalesce(nullif(btrim(pp.full_name), ''), 'A parent') into v_name from public.parent_profiles pp where pp.id = r.user_id;
    insert into public.notifications (user_id, type, title, body, data)
    values (
      r.user_id, 'monthly_invoice_overdue', 'Your ' || r.title || ' payment is overdue',
      'Your ' || to_char(r.period_start, 'FMMonth') || ' invoice of ' || public.monthly_money(r.amount_cents)
        || ' was due on the 5th. You can''t book more sessions in ' || r.title || ' until it is paid.',
      jsonb_build_object('url', '/profile?tab=monthly', 'invoice_id', r.id, 'activity_name', r.title,
                         'month', to_char(r.period_start, 'FMMonth YYYY'),
                         'amount', public.monthly_money(r.amount_cents))
    );
    perform public.monthly_notify_vendor(
      r.provider_id, 'provider_monthly_invoice_overdue', v_name || ' has an overdue invoice',
      v_name || ' has not paid their ' || to_char(r.period_start, 'FMMonth') || ' invoice of '
        || public.monthly_money(r.amount_cents) || ' for ' || r.title
        || '. They can''t book more sessions until it is paid.',
      jsonb_build_object('url', '/vendor/#/monthly-billing', 'invoice_id', r.id, 'activity_name', r.title,
                         'parent_name', v_name, 'amount', public.monthly_money(r.amount_cents),
                         'month', to_char(r.period_start, 'FMMonth YYYY'))
    );
  end loop;

  return jsonb_build_object('ended', v_ended, 'issued', v_issued, 'reminded', v_reminded, 'overdue', v_overdue);
end;
$$;

-- =============================================================
-- 11. Who may call what (SQL functions are public by default)
-- =============================================================
revoke all on function public.guard_monthly_billing_enabled() from public, anon, authenticated;
revoke all on function public.monthly_billing_gate() from public, anon, authenticated;
revoke all on function public.monthly_notify_vendor(uuid, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.monthly_has_overdue(uuid, uuid) from public, anon, authenticated;
revoke all on function public.monthly_mark_invoice_paid(uuid, text, text) from public, anon, authenticated;
revoke all on function public.monthly_billing_daily() from public, anon, authenticated;
grant execute on function public.monthly_mark_invoice_paid(uuid, text, text) to service_role;
grant execute on function public.monthly_billing_daily() to service_role;

revoke all on function public.monthly_enrol(uuid) from public, anon;
revoke all on function public.monthly_give_notice(uuid) from public, anon;
revoke all on function public.monthly_withdraw_notice(uuid) from public, anon;
revoke all on function public.monthly_unbilled(uuid) from public, anon;
revoke all on function public.monthly_settle_invoice(uuid, text, text) from public, anon;
revoke all on function public.monthly_provider_enrolments(uuid) from public, anon;
revoke all on function public.monthly_provider_invoices(uuid) from public, anon;
grant execute on function public.monthly_enrol(uuid) to authenticated;
grant execute on function public.monthly_give_notice(uuid) to authenticated;
grant execute on function public.monthly_withdraw_notice(uuid) to authenticated;
grant execute on function public.monthly_unbilled(uuid) to authenticated;
grant execute on function public.monthly_settle_invoice(uuid, text, text) to authenticated;
grant execute on function public.monthly_provider_enrolments(uuid) to authenticated;
grant execute on function public.monthly_provider_invoices(uuid) to authenticated;

-- =============================================================
-- 12. Schedule: 09:00 Singapore (01:00 UTC) every day
-- =============================================================
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'monthly-billing-daily';
    perform cron.schedule('monthly-billing-daily', '0 1 * * *', 'select public.monthly_billing_daily();');
  end if;
end $$;

notify pgrst, 'reload schema';

commit;
