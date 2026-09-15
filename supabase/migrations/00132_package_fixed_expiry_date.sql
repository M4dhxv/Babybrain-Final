-- 00132_package_fixed_expiry_date.sql
--
-- Packages could only expire N days after each purchase (validity_days,
-- 00026) — no way to set a pack that just expires on a fixed calendar date
-- (e.g. "valid through end of term") regardless of when it was bought.
--
-- expiry_date is that fixed date (SGT), mutually exclusive with
-- validity_days. stamp_package_purchase_expiry() now prefers it when set,
-- stamping every purchase of that pack with the same end-of-day instant
-- instead of purchase_date + validity_days.
--
-- Idempotent.

begin;

alter table public.packages
  add column if not exists expiry_date date;

alter table public.packages
  drop constraint if exists packages_one_expiry_mode;
alter table public.packages
  add constraint packages_one_expiry_mode
    check (validity_days is null or expiry_date is null);

create or replace function public.stamp_package_purchase_expiry()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_days integer; v_date date;
begin
  if new.expires_at is null then
    select validity_days, expiry_date into v_days, v_date from public.packages where id = new.package_id;
    if v_date is not null then
      -- End of the fixed date in Singapore time, so a purchase on that same
      -- day still gets the rest of it (same convention as make_up_tokens'
      -- custom expiry, see MakeUpTokensPage.tsx).
      new.expires_at := (v_date::timestamp + interval '23:59:59') at time zone 'Asia/Singapore';
    elsif v_days is not null then
      new.expires_at := now() + make_interval(days => v_days);
    end if;
  end if;
  return new;
end;
$$;

notify pgrst, 'reload schema';

commit;
