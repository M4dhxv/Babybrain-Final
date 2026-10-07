-- Where a parent came from. Shown (as an optional column) on Admin -> Parents.
--
-- The parent app remembers the first campaign link / referrer a visitor arrived
-- through (utm_source, utm_medium, utm_campaign, ref, document.referrer) and
-- sends it with the sign-up inside the auth user's metadata, as
-- `attribution: { source, medium, campaign, referrer }`. This copies it onto the
-- parent's profile row.
--
-- A separate trigger rather than a change to handle_new_user(): that function
-- has been rebuilt several times (00165, 00186) and each rebuild risked
-- dropping a guard, so it is left alone. This one only fills these four columns
-- and does nothing when there is no profile row (vendor sign-ups skip it) or no
-- attribution in the metadata. It runs after handle_new_user() because triggers
-- on the same event fire in name order: "on_auth_user_created" sorts before
-- "on_auth_user_created_signup_source".
--
-- Existing parents stay empty (shown as unknown) - their source was never recorded.

begin;

alter table public.parent_profiles
  add column if not exists signup_source text,
  add column if not exists signup_medium text,
  add column if not exists signup_campaign text,
  add column if not exists signup_referrer text;

comment on column public.parent_profiles.signup_source is
  'First-touch source at sign-up (utm_source / ref / referrer host, or "direct"). Admin analytics only.';

create or replace function public.capture_signup_source()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  a jsonb := new.raw_user_meta_data -> 'attribution';
begin
  if a is null or jsonb_typeof(a) <> 'object' then
    return new;
  end if;
  update public.parent_profiles
     set signup_source   = nullif(left(btrim(a ->> 'source'), 80), ''),
         signup_medium   = nullif(left(btrim(a ->> 'medium'), 80), ''),
         signup_campaign = nullif(left(btrim(a ->> 'campaign'), 120), ''),
         signup_referrer = nullif(left(btrim(a ->> 'referrer'), 120), '')
   where id = new.id;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_signup_source on auth.users;
create trigger on_auth_user_created_signup_source
  after insert on auth.users
  for each row execute function public.capture_signup_source();

notify pgrst, 'reload schema';

commit;
