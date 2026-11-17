-- 00274_term_withdrawal_policy.sql
--
-- A vendor decides, per term, whether a family may withdraw BEFORE the term starts and what they get back:
--
--   money    what they paid, less the payment processor's (Stripe's) fee. Processed by hand: the withdrawal is
--            recorded as "refund due" and someone marks it done once the money has gone back to the card.
--   credit   a dollar credit with that vendor, spendable on any later term of theirs, valid for a number of days
--            the vendor sets.
--   none     nothing. The booking page shows a disclaimer beside the booking button.
--
-- Once the term has started a parent can no longer withdraw online: they ask the vendor, who can still withdraw
-- them from the portal (vendor_withdraw_from_term, unchanged).
--
-- Opt-in, so nothing changes for a term that already exists: terms.withdraw_allowed is NULL = "no policy set",
-- and withdraw_from_term() then behaves exactly as it did in 00264 (the activity's cancellation switch and
-- refund mode). The vendor portal writes an explicit policy for every term it saves from now on.
--
--   terms.withdraw_allowed       null = follow the activity (legacy), true / false = the policy below
--   terms.withdraw_refund_mode   'money' | 'credit' | 'none' (required when withdrawals are allowed)
--   terms.credit_valid_days      how long a credit lasts (default 365)
--   term_withdrawals             one row per enrolment withdrawn under a policy: what was paid, what happens
--   term_credits                 a family's dollar credit with a vendor
--   term_credit_holds            credit set aside for a checkout in progress (lapses by itself after 50 minutes)
--
-- Credit is spent through /api/terms/checkout: term_credit_hold() sets it aside while the parent pays, and
-- term_credit_settle() spends it once the seats are confirmed. A hold that is never settled simply stops
-- counting after it expires, so abandoned checkouts need no clean-up.
--
-- Refunds are never made by the database or by code: money moves only when a person processes it, then records
-- it with vendor_mark_term_refund().
--
-- Idempotent.

begin;

-- =============================================================
-- 1. The policy, on the term
-- =============================================================
alter table public.terms
  add column if not exists withdraw_allowed boolean,
  add column if not exists withdraw_refund_mode text,
  add column if not exists credit_valid_days int not null default 365;

alter table public.terms drop constraint if exists terms_withdraw_refund_mode_check;
alter table public.terms
  add constraint terms_withdraw_refund_mode_check
  check (withdraw_refund_mode is null or withdraw_refund_mode in ('money', 'credit', 'none'));

alter table public.terms drop constraint if exists terms_withdraw_policy_complete;
alter table public.terms
  add constraint terms_withdraw_policy_complete
  check (withdraw_allowed is not true or withdraw_refund_mode is not null);

alter table public.terms drop constraint if exists terms_credit_valid_days_check;
alter table public.terms
  add constraint terms_credit_valid_days_check check (credit_valid_days between 1 and 1825);

-- =============================================================
-- 2. Credits and withdrawal records
-- =============================================================
create table if not exists public.term_credits (
  id                   uuid primary key default gen_random_uuid(),
  provider_id          uuid not null references public.providers (id) on delete cascade,
  user_id              uuid not null references public.parent_profiles (id) on delete cascade,
  amount_cents         int  not null check (amount_cents > 0),
  remaining_cents      int  not null check (remaining_cents >= 0),
  expires_at           timestamptz not null,
  source_withdrawal_id uuid,
  created_at           timestamptz not null default now()
);
create index if not exists term_credits_user_idx on public.term_credits (user_id, provider_id);

create table if not exists public.term_credit_holds (
  id           uuid primary key default gen_random_uuid(),
  credit_id    uuid not null references public.term_credits (id) on delete cascade,
  group_id     uuid not null,
  amount_cents int  not null check (amount_cents > 0),
  status       text not null default 'held' check (status in ('held', 'spent')),
  expires_at   timestamptz not null,
  created_at   timestamptz not null default now()
);
create index if not exists term_credit_holds_credit_idx on public.term_credit_holds (credit_id, status);
create index if not exists term_credit_holds_group_idx on public.term_credit_holds (group_id);

create table if not exists public.term_withdrawals (
  id           uuid primary key default gen_random_uuid(),
  enrolment_id uuid not null unique references public.term_enrolments (id) on delete cascade,
  term_id      uuid not null references public.terms (id) on delete cascade,
  provider_id  uuid not null references public.providers (id) on delete cascade,
  user_id      uuid not null references public.parent_profiles (id) on delete cascade,
  child_id     uuid references public.children (id) on delete set null,
  -- The policy that applied: 'money' | 'credit' | 'none'.
  outcome      text not null check (outcome in ('money', 'credit', 'none')),
  -- Cash actually paid for this enrolment (what a money refund is taken from).
  paid_cents   int  not null default 0 check (paid_cents >= 0),
  -- Credit handed back to the family (the whole payment under 'credit', or just the credit they spent).
  credit_cents int  not null default 0 check (credit_cents >= 0),
  credit_id    uuid references public.term_credits (id) on delete set null,
  -- 'money' only: what the processor kept, and what went back. Filled in by hand.
  fee_cents    int  check (fee_cents is null or fee_cents >= 0),
  refund_cents int  check (refund_cents is null or refund_cents >= 0),
  status       text not null check (status in ('refund_due', 'refund_done', 'credit_issued', 'no_refund', 'nothing_paid')),
  note         text,
  created_at   timestamptz not null default now(),
  processed_at timestamptz,
  processed_by uuid
);
create index if not exists term_withdrawals_provider_idx on public.term_withdrawals (provider_id, status);
create index if not exists term_withdrawals_user_idx on public.term_withdrawals (user_id);

alter table public.term_credits enable row level security;
alter table public.term_credit_holds enable row level security;
alter table public.term_withdrawals enable row level security;

drop policy if exists "read own term credits" on public.term_credits;
create policy "read own term credits" on public.term_credits for select using (user_id = auth.uid());
drop policy if exists "members read term credits" on public.term_credits;
create policy "members read term credits" on public.term_credits
  for select using (provider_id in (select public.user_provider_ids()));

drop policy if exists "read own term withdrawals" on public.term_withdrawals;
create policy "read own term withdrawals" on public.term_withdrawals for select using (user_id = auth.uid());
drop policy if exists "members read term withdrawals" on public.term_withdrawals;
create policy "members read term withdrawals" on public.term_withdrawals
  for select using (provider_id in (select public.user_provider_ids()));
-- Writes: only the functions below (security definer) and the service role.

-- =============================================================
-- 3. Withdraw (parent): the policy first, the old rule when there is none
-- =============================================================
-- 00264's function, with the policy branch in front. A term with no policy
-- (withdraw_allowed is null) runs the unchanged code below it.
create or replace function public.withdraw_from_term(p_enrolment_id uuid)
returns int
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_user    uuid := auth.uid();
  v_e       public.term_enrolments;
  v_term    public.terms;
  v_ids     uuid[];
  v_slots   uuid[];
  v_allow   boolean;
  v_cut     int;
  v_mode    text;
  v_started boolean;
  v_n       int;
  v_slot    uuid;
  v_eid     uuid;
  v_grp     uuid;
  v_paid    int;
  v_spent   int;
  v_share   int;
  v_credit  int;
  v_cid     uuid;
  v_wid     uuid;
  v_status  text;
  v_title   text;
begin
  if v_user is null then raise exception 'Not authenticated'; end if;
  select * into v_e from public.term_enrolments where id = p_enrolment_id and user_id = v_user;
  if not found then raise exception 'That enrolment was not found.'; end if;

  -- 00264: a combination is withdrawn whole (a parent cannot drop one slot).
  select array_agg(e.id), array_agg(e.slot_id) into v_ids, v_slots
  from public.term_enrolments e
  where e.user_id = v_user
    and (e.id = p_enrolment_id or (v_e.combo_id is not null and e.combo_id = v_e.combo_id));

  select t.* into v_term from public.terms t where t.id = v_e.term_id;

  -- Started = a session of the group has passed its booking window (the
  -- moment term_quote counts it as run).
  select coalesce(bool_or((select q.sessions_passed > 0 from public.term_quote(x) q)), false)
    into v_started from unnest(v_slots) x;

  if v_term.withdraw_allowed is not null then
    -- ---- 00274: the vendor's policy for this term
    if not v_term.withdraw_allowed then
      raise exception 'The provider does not allow withdrawals from this term. Contact them to withdraw.';
    end if;
    if v_started then
      raise exception 'This term has started, so it can no longer be withdrawn online. Contact the provider.';
    end if;

    select a.title into v_title from public.activities a where a.id = v_term.activity_id;

    foreach v_eid in array v_ids loop
      -- What this enrolment paid in cash, and its share of any credit spent on the checkout.
      select coalesce(sum(round(b.amount * 100)), 0)::int into v_paid
      from public.bookings b
      where b.term_enrolment_id = v_eid and b.user_id = v_user
        and b.payment_status = 'paid' and b.status in ('pending', 'confirmed');

      select e.booking_group_id into v_grp from public.term_enrolments e where e.id = v_eid;
      select coalesce(sum(h.amount_cents), 0)::int into v_spent
      from public.term_credit_holds h where h.group_id = v_grp and h.status = 'spent';
      select case when sum(e.price_cents) > 0
                  then round(v_spent * (select e2.price_cents from public.term_enrolments e2 where e2.id = v_eid)::numeric / sum(e.price_cents))::int
                  else 0 end
        into v_share
      from public.term_enrolments e where e.booking_group_id = v_grp;

      v_credit := case v_term.withdraw_refund_mode
                    when 'credit' then v_paid + coalesce(v_share, 0)
                    when 'money'  then coalesce(v_share, 0)   -- credit already spent comes back as credit, never as cash
                    else 0 end;
      v_cid := null;
      if v_credit > 0 then
        insert into public.term_credits (provider_id, user_id, amount_cents, remaining_cents, expires_at)
        values (v_term.provider_id, v_user, v_credit, v_credit,
                now() + make_interval(days => coalesce(v_term.credit_valid_days, 365)))
        returning id into v_cid;
      end if;

      v_status := case
                    when v_paid = 0 and coalesce(v_share, 0) = 0 then 'nothing_paid'
                    when v_term.withdraw_refund_mode = 'money' and v_paid > 0 then 'refund_due'
                    when v_credit > 0 then 'credit_issued'
                    else 'no_refund' end;

      insert into public.term_withdrawals
        (enrolment_id, term_id, provider_id, user_id, child_id, outcome, paid_cents, credit_cents, credit_id, status)
      values
        (v_eid, v_term.id, v_term.provider_id, v_user, (select e.child_id from public.term_enrolments e where e.id = v_eid),
         v_term.withdraw_refund_mode, v_paid, v_credit, v_cid, v_status)
      returning id into v_wid;
      if v_cid is not null then
        update public.term_credits set source_withdrawal_id = v_wid where id = v_cid;
      end if;

      insert into public.notifications (user_id, type, title, body, data)
      values (
        v_user, 'term_withdrawn', 'You have withdrawn from ' || coalesce(v_title, 'the term'),
        case v_status
          when 'refund_due' then 'Your refund (what you paid less the payment processing fee) will be processed by hand.'
          when 'credit_issued' then 'You have a credit with the provider for another term.'
          when 'no_refund' then 'This term is non-refundable, so there is nothing to refund.'
          else 'Nothing had been paid, so there is nothing to refund.' end,
        jsonb_build_object('withdrawal_id', v_wid, 'status', v_status, 'term_name', v_term.name,
                           'activity_title', v_title, 'paid_cents', v_paid, 'credit_cents', v_credit,
                           'credit_days', v_term.credit_valid_days)
      );
    end loop;

    -- No cancellation window here: the policy is "before the term starts", so every
    -- session still to come goes. No make-up token either (cancel_refund_mode 'none'):
    -- the outcome above is the whole remedy.
    update public.bookings b
       set status = 'cancelled',
           cancel_refund_mode = 'none',
           cancel_reason = 'Withdrew before the term started'
      from public.activity_sessions s
     where s.id = b.session_id
       and b.term_enrolment_id = any (v_ids)
       and b.user_id = v_user
       and b.status in ('pending', 'confirmed', 'waitlisted')
       and s.starts_at > now();
    get diagnostics v_n = row_count;
    if v_n = 0 then
      raise exception 'There are no sessions left that can still be cancelled.';
    end if;
    foreach v_slot in array v_slots loop
      perform public.offer_term_place(v_slot);
    end loop;
    return v_n;
  end if;

  -- ---- No policy set: the activity's rules, exactly as 00264.
  select a.allow_cancellation, a.cancellation_cutoff_hours, a.cancellation_refund_mode
    into v_allow, v_cut, v_mode
  from public.terms t join public.activities a on a.id = t.activity_id
  where t.id = v_e.term_id;
  if not coalesce(v_allow, true) then
    raise exception 'The provider does not allow cancellations for this class. Contact them to withdraw.';
  end if;

  update public.bookings b
     set status = 'cancelled',
         cancel_refund_mode = case when v_started then 'none' else coalesce(v_mode, 'refund') end,
         cancel_reason = case when v_started then 'Withdrew after the term started' else b.cancel_reason end
    from public.activity_sessions s
   where s.id = b.session_id
     and b.term_enrolment_id = any (v_ids)
     and b.user_id = v_user
     and b.status in ('pending', 'confirmed', 'waitlisted')
     and s.starts_at - make_interval(hours => coalesce(s.cancellation_cutoff_hours, v_cut, 0)) > now();
  get diagnostics v_n = row_count;
  if v_n = 0 then
    raise exception 'There are no sessions left that can still be cancelled.';
  end if;
  foreach v_slot in array v_slots loop
    perform public.offer_term_place(v_slot);
  end loop;
  return v_n;
end;
$$;

-- =============================================================
-- 4. Vendor / admin: record that a money refund has been processed
-- =============================================================
create or replace function public.vendor_mark_term_refund(p_withdrawal_id uuid, p_fee_cents int, p_note text default null)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_w     public.term_withdrawals;
  v_title text;
begin
  select * into v_w from public.term_withdrawals where id = p_withdrawal_id for update;
  if not found or v_w.provider_id not in (select public.user_manage_provider_ids()) then
    raise exception 'not authorized';
  end if;
  if v_w.status <> 'refund_due' then
    raise exception 'This withdrawal has no refund waiting to be processed.';
  end if;
  if p_fee_cents is null or p_fee_cents < 0 or p_fee_cents > v_w.paid_cents then
    raise exception 'The processing fee must be between 0 and what was paid.';
  end if;

  update public.term_withdrawals
     set fee_cents = p_fee_cents,
         refund_cents = v_w.paid_cents - p_fee_cents,
         status = 'refund_done',
         note = nullif(btrim(p_note), ''),
         processed_at = now(),
         processed_by = auth.uid()
   where id = p_withdrawal_id;

  select a.title into v_title
  from public.terms t join public.activities a on a.id = t.activity_id where t.id = v_w.term_id;
  insert into public.notifications (user_id, type, title, body, data)
  values (
    v_w.user_id, 'term_refund_processed', 'Your refund has been processed',
    'Your refund for ' || coalesce(v_title, 'the term') || ' has gone back to the card you paid with.',
    jsonb_build_object('withdrawal_id', p_withdrawal_id, 'activity_title', v_title,
                       'refund_cents', v_w.paid_cents - p_fee_cents, 'fee_cents', p_fee_cents)
  );
end;
$$;

-- =============================================================
-- 5. Credit: what a parent has, and spending it at checkout
-- =============================================================
-- Credit not held by a checkout in progress, with one vendor (that of the activity).
create or replace function public.term_credit_balance(p_activity_id uuid)
returns table (balance_cents int, expires_at timestamptz)
language sql
stable
security definer
set search_path to 'public'
as $$
  with mine as (
    select c.id, c.remaining_cents, c.expires_at
    from public.term_credits c
    join public.activities a on a.provider_id = c.provider_id and a.id = p_activity_id
    where c.user_id = auth.uid() and c.remaining_cents > 0 and c.expires_at > now()
  ),
  free as (
    select m.expires_at,
           m.remaining_cents - coalesce((select sum(h.amount_cents) from public.term_credit_holds h
                                         where h.credit_id = m.id and h.status = 'held' and h.expires_at > now()), 0) as cents
    from mine m
  )
  select coalesce(sum(f.cents) filter (where f.cents > 0), 0)::int, min(f.expires_at) filter (where f.cents > 0)
  from free f;
$$;

-- Sets credit aside for one checkout (earliest-expiring first) and returns how much was set aside,
-- never more than p_total_cents. Server-only: the checkout route has already proved the seats are the
-- caller's. Calling it again for the same group replaces the earlier hold.
create or replace function public.term_credit_hold(p_user uuid, p_group_id uuid, p_total_cents int)
returns int
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_provider uuid;
  v_need     int := greatest(0, coalesce(p_total_cents, 0));
  v_applied  int := 0;
  r          record;
  v_take     int;
begin
  select t.provider_id into v_provider
  from public.bookings b
  join public.activity_sessions s on s.id = b.session_id
  join public.term_slots ts on ts.id = s.term_slot_id
  join public.terms t on t.id = ts.term_id
  where b.booking_group_id = p_group_id and b.user_id = p_user
  limit 1;
  if v_provider is null then
    raise exception 'That booking was not found.';
  end if;

  delete from public.term_credit_holds where group_id = p_group_id and status = 'held';

  for r in
    select c.id,
           c.remaining_cents - coalesce((select sum(h.amount_cents) from public.term_credit_holds h
                                         where h.credit_id = c.id and h.status = 'held' and h.expires_at > now()), 0) as free_cents
    from public.term_credits c
    where c.user_id = p_user and c.provider_id = v_provider and c.remaining_cents > 0 and c.expires_at > now()
    order by c.expires_at, c.created_at
    for update of c
  loop
    exit when v_need <= 0;
    continue when r.free_cents <= 0;
    v_take := least(r.free_cents, v_need);
    insert into public.term_credit_holds (credit_id, group_id, amount_cents, expires_at)
    values (r.id, p_group_id, v_take, now() + interval '50 minutes');
    v_need := v_need - v_take;
    v_applied := v_applied + v_take;
  end loop;
  return v_applied;
end;
$$;

-- Spends what term_credit_hold set aside, once the checkout's seats are confirmed. Safe to call twice
-- and for a group that held nothing.
create or replace function public.term_credit_settle(p_group_id uuid)
returns int
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  r       record;
  v_total int := 0;
begin
  for r in select h.id, h.credit_id, h.amount_cents from public.term_credit_holds h
           where h.group_id = p_group_id and h.status = 'held' for update
  loop
    update public.term_credits set remaining_cents = greatest(0, remaining_cents - r.amount_cents) where id = r.credit_id;
    update public.term_credit_holds set status = 'spent' where id = r.id;
    v_total := v_total + r.amount_cents;
  end loop;
  return v_total;
end;
$$;

-- =============================================================
-- 6. Who may call what
-- =============================================================
revoke all on function public.withdraw_from_term(uuid) from public, anon;
grant execute on function public.withdraw_from_term(uuid) to authenticated;

revoke all on function public.vendor_mark_term_refund(uuid, int, text) from public, anon;
grant execute on function public.vendor_mark_term_refund(uuid, int, text) to authenticated;

revoke all on function public.term_credit_balance(uuid) from public, anon;
grant execute on function public.term_credit_balance(uuid) to authenticated;

revoke all on function public.term_credit_hold(uuid, uuid, int) from public, anon, authenticated;
grant execute on function public.term_credit_hold(uuid, uuid, int) to service_role;
revoke all on function public.term_credit_settle(uuid) from public, anon, authenticated;
grant execute on function public.term_credit_settle(uuid) to service_role;

notify pgrst, 'reload schema';

commit;
