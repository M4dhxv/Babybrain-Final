-- 00271_monthly_billing_optional.sql
--
-- Monthly billing becomes a choice the parent makes, not the only way to book an activity.
--
-- 00268 made an activity with monthly_billing_enabled monthly-only: every parent booking had to come
-- through an enrolment, and anyone without one was refused. Now the switch means "monthly billing is
-- OFFERED here":
--
--   * A parent who has NOT enrolled books exactly as before: pay per booking through Stripe, a package
--     credit, a make-up token. The gate leaves their booking alone.
--   * A parent who HAS enrolled (monthly_enrol, status active or ending) books on account: the seat is
--     confirmed unpaid and goes on the next monthly invoice. While enrolled every booking in that
--     activity is monthly, so a package credit is refused there (it would be paid twice). Giving notice
--     and leaving returns them to paying per booking.
--   * An overdue monthly invoice still blocks every new booking in that activity, enrolled or not,
--     whichever way they would have paid. Paying it, or the vendor marking it paid, lifts it.
--
-- Only monthly_billing_gate changes. Idempotent.

begin;

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
    return new;                       -- an ordinary activity: not our business
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

  -- Dues come first, whichever way this booking would have been paid.
  if public.monthly_has_overdue(new.user_id, v_activity) then
    raise exception 'You have an overdue monthly payment for %. Please pay it before booking more sessions.', v_title;
  end if;

  select e.* into v_enrol
  from public.monthly_enrolments e
  where e.user_id = new.user_id and e.activity_id = v_activity and e.status in ('active', 'ending')
  limit 1;
  if not found then
    return new;                       -- not enrolled: an ordinary booking, paid the ordinary way
  end if;

  if new.package_purchase_id is not null then
    raise exception 'You are on monthly billing for %, so package credits can''t be used for it. Give notice to go back to paying per booking.', v_title;
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

revoke all on function public.monthly_billing_gate() from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;
