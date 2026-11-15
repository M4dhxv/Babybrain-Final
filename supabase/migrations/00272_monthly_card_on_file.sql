-- 00272_monthly_card_on_file.sql
--
-- A parent can save a card with Stripe for monthly billing, so the invoice is charged on the 1st
-- instead of waiting for them to pay a link. Plus the detail the vendor and parent sections need.
--
--   * monthly_payment_methods   one saved card per parent (Stripe customer + payment method, and the
--                               brand / last four / expiry to show). Written only by the server after
--                               Stripe confirms the card; the parent can read their own row, nobody else.
--   * monthly_invoices          charge_attempts / charge_attempted_at / charge_error: what the daily
--                               charge run did. A failed charge changes nothing else: the invoice stays
--                               open, the parent is told, and they still have until the end of the 5th.
--   * monthly_enrolment_sessions(enrolment)   the seats behind one enrolment, for the parent's own
--                               section and the vendor's Monthly enrolments tab.
--   * monthly_provider_enrolments / monthly_provider_invoices   gain has_card (never the card itself)
--                               and the last charge error. Added columns only, so portal code that
--                               does not know them keeps working.
--   * pg_cron 'monthly-billing-charge' at 01:30 UTC (09:30 Singapore), half an hour after the invoices
--     are issued, calls /api/cron/monthly-charge.
--
-- Idempotent.

begin;

-- =============================================================
-- 1. The saved card
-- =============================================================
create table if not exists public.monthly_payment_methods (
  user_id                  uuid primary key references public.parent_profiles (id) on delete cascade,
  stripe_customer_id       text not null,
  stripe_payment_method_id text not null,
  brand                    text,
  last4                    text,
  exp_month                int,
  exp_year                 int,
  -- When the parent agreed to have it charged for their monthly invoices (the Stripe page they saved it on).
  consented_at             timestamptz not null default now(),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

alter table public.monthly_payment_methods enable row level security;
drop policy if exists "read own monthly card" on public.monthly_payment_methods;
create policy "read own monthly card" on public.monthly_payment_methods
  for select using (user_id = auth.uid());

-- =============================================================
-- 2. What the charge run did to an invoice
-- =============================================================
alter table public.monthly_invoices
  add column if not exists charge_attempts     int not null default 0,
  add column if not exists charge_attempted_at timestamptz,
  add column if not exists charge_error        text;

-- =============================================================
-- 3. The seats behind one enrolment
-- =============================================================
create or replace function public.monthly_enrolment_sessions(p_enrolment_id uuid)
returns table (
  booking_id uuid, session_id uuid, starts_at timestamptz, ends_at timestamptz, status text,
  child_name text, guest_name text, amount_cents int, invoice_id uuid, period_start date
)
language sql
stable
security definer
set search_path to 'public'
as $$
  select b.id, b.session_id, s.starts_at, s.ends_at, b.status::text,
         c.name, b.guest_name,
         round(coalesce(b.amount, public.session_price(b.session_id), 0) * 100)::int,
         b.monthly_invoice_id,
         date_trunc('month', s.starts_at at time zone 'Asia/Singapore')::date
  from public.monthly_enrolments e
  join public.bookings b on b.monthly_enrolment_id = e.id
  join public.activity_sessions s on s.id = b.session_id
  left join public.children c on c.id = b.child_id
  where e.id = p_enrolment_id
    and (e.user_id = auth.uid() or e.provider_id in (select public.user_provider_ids()))
  order by s.starts_at desc
  limit 300;
$$;

-- =============================================================
-- 4. Vendor lists: has_card and the last charge error
-- =============================================================
drop function if exists public.monthly_provider_enrolments(uuid);
create function public.monthly_provider_enrolments(p_provider uuid)
returns table (
  enrolment_id uuid, activity_id uuid, activity_title text, user_id uuid,
  parent_name text, parent_email text, status text, enrolled_at timestamptz, ends_at timestamptz,
  unbilled_sessions int, unbilled_cents int, open_cents int, overdue_cents int,
  has_card boolean, charge_error text
)
language sql
stable
security definer
set search_path to 'public'
as $$
  select e.id, e.activity_id, a.title, e.user_id,
         coalesce(nullif(btrim(pp.full_name), ''), 'Parent'), pp.email, e.status, e.enrolled_at, e.ends_at,
         coalesce(u.n, 0), coalesce(u.cents, 0),
         coalesce(o.open_cents, 0), coalesce(o.overdue_cents, 0),
         exists (select 1 from public.monthly_payment_methods m where m.user_id = e.user_id),
         o.charge_error
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
           coalesce(sum(i.amount_cents) filter (where i.due_at <= now()), 0)::int as overdue_cents,
           (array_agg(i.charge_error order by i.due_at) filter (where i.charge_error is not null))[1] as charge_error
    from public.monthly_invoices i where i.enrolment_id = e.id and i.status = 'open'
  ) o on true
  where e.provider_id = p_provider
    and p_provider in (select public.user_provider_ids())
  order by (e.status = 'ended'), a.title, pp.full_name;
$$;

drop function if exists public.monthly_provider_invoices(uuid);
create function public.monthly_provider_invoices(p_provider uuid)
returns table (
  invoice_id uuid, enrolment_id uuid, activity_id uuid, activity_title text, user_id uuid,
  parent_name text, parent_email text, period_start date, session_count int, amount_cents int,
  status text, issued_at timestamptz, due_at timestamptz, paid_at timestamptz, paid_manually boolean,
  overdue boolean, settle_note text,
  has_card boolean, charge_attempts int, charge_error text
)
language sql
stable
security definer
set search_path to 'public'
as $$
  select i.id, i.enrolment_id, i.activity_id, a.title, i.user_id,
         coalesce(nullif(btrim(pp.full_name), ''), 'Parent'), pp.email, i.period_start, i.session_count,
         i.amount_cents, i.status, i.issued_at, i.due_at, i.paid_at, i.paid_manually,
         (i.status = 'open' and i.due_at <= now()), i.settle_note,
         exists (select 1 from public.monthly_payment_methods m where m.user_id = i.user_id),
         i.charge_attempts, i.charge_error
  from public.monthly_invoices i
  join public.activities a on a.id = i.activity_id
  left join public.parent_profiles pp on pp.id = i.user_id
  where i.provider_id = p_provider
    and p_provider in (select public.user_provider_ids())
  order by (i.status = 'open') desc, i.due_at desc, i.created_at desc;
$$;

-- =============================================================
-- 5. Who may call what
-- =============================================================
revoke all on function public.monthly_enrolment_sessions(uuid) from public, anon;
revoke all on function public.monthly_provider_enrolments(uuid) from public, anon;
revoke all on function public.monthly_provider_invoices(uuid) from public, anon;
grant execute on function public.monthly_enrolment_sessions(uuid) to authenticated;
grant execute on function public.monthly_provider_enrolments(uuid) to authenticated;
grant execute on function public.monthly_provider_invoices(uuid) to authenticated;

-- =============================================================
-- 6. Schedule: 09:30 Singapore (01:30 UTC), after monthly_billing_daily has issued the invoices
-- =============================================================
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'monthly-billing-charge';
    perform cron.schedule(
      'monthly-billing-charge',
      '30 1 * * *',
      $job$
      select net.http_post(
        url     := public.app_base_url() || '/api/cron/monthly-charge',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_shared_secret')
        ),
        body    := '{}'::jsonb
      );
      $job$
    );
  end if;
end $$;

notify pgrst, 'reload schema';

commit;
