-- 00094_marketing_consent.sql
--
-- QA 04/09, one row each for parents and vendors: "Need to add a marketing
-- consent on account creation — a checkbox saying 'I agree and consent to
-- receive marketing communications from BabyBrain to update me on offers,
-- promotions, discounts, events, news, etc. relating to BabyBrain's products
-- and services via any means of communication such as via email.'"
--
-- Stored as a timestamp rather than a boolean, mirroring terms_accepted_at
-- (00015/00076): consent is a thing that happened at a moment, and for a
-- marketing permission the date is the part you actually need if anyone ever
-- asks. NULL means no consent — which is the correct default, and what every
-- existing account gets. Nothing here starts sending anything; it records the
-- permission so the sending side can be gated on it.
--
-- Withdrawal is a matter of setting it back to NULL, which is what an
-- unsubscribe should do.

begin;

alter table public.parent_profiles
  add column if not exists marketing_consent_at timestamptz;

alter table public.providers
  add column if not exists marketing_consent_at timestamptz;

comment on column public.parent_profiles.marketing_consent_at is
  'When this parent agreed to receive marketing communications. NULL = no '
  'consent (the default). Clearing it back to NULL is how consent is withdrawn.';
comment on column public.providers.marketing_consent_at is
  'When this provider agreed to receive marketing communications. NULL = no '
  'consent (the default).';

-- Carry the checkbox through sign-up. With email confirmation on there is no
-- session at sign-up, so the whole onboarding draft rides in as auth metadata
-- and this function materialises it (00036) — the consent has to travel the
-- same way or it would be lost exactly like the children were.
--
-- Unchanged from 00036 except for the marketing_consent line. Note it tests
-- the VALUE, not just the key's presence the way terms_accepted does: terms
-- are a precondition of signing up at all, so their key only appears when
-- accepted, but marketing consent is genuinely optional and an unticked box
-- must not be recorded as a yes.
create or replace function public.apply_signup_payload(p_user_id uuid, p_meta jsonb)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_kid   jsonb;
  v_dob   date;
  v_kids  jsonb := p_meta -> 'children';
begin
  update public.parent_profiles
     set full_name         = coalesce(nullif(trim(p_meta ->> 'full_name'), ''), full_name),
         phone             = coalesce(nullif(trim(p_meta ->> 'phone'), ''), phone),
         postal_code       = coalesce(nullif(trim(p_meta ->> 'postal_code'), ''), postal_code),
         terms_accepted_at = coalesce(terms_accepted_at,
                                      case when p_meta ? 'terms_accepted' then now() end),
         -- Tests the VALUE, not just the key's presence the way terms_accepted
         -- does: terms are a precondition of signing up at all, so that key
         -- only appears when accepted, but marketing consent is genuinely
         -- optional and an unticked box must not be recorded as a yes.
         marketing_consent_at = coalesce(
           marketing_consent_at,
           case when (p_meta ->> 'marketing_consent')::boolean then now() end)
   where id = p_user_id;

  if p_meta ? 'preferences' then
    update public.user_preferences up
       set preferred_days    = coalesce(
             (select array_agg(value::text) from jsonb_array_elements_text(p_meta -> 'preferences' -> 'days')),
             up.preferred_days),
           preferred_times   = coalesce(
             (select array_agg(value::text) from jsonb_array_elements_text(p_meta -> 'preferences' -> 'times')),
             up.preferred_times),
           preferred_regions = coalesce(
             (select array_agg(value::text) from jsonb_array_elements_text(p_meta -> 'preferences' -> 'regions')),
             up.preferred_regions),
           interests         = coalesce(
             (select array_agg(value::text) from jsonb_array_elements_text(p_meta -> 'preferences' -> 'interests')),
             up.interests),
           budget_min        = coalesce((p_meta -> 'preferences' ->> 'budget_min')::numeric, up.budget_min),
           budget_max        = coalesce((p_meta -> 'preferences' ->> 'budget_max')::numeric, up.budget_max)
     where up.user_id = p_user_id;
  end if;

  -- Only seed children when the parent has none, so a replayed confirmation
  -- (or a second trigger firing) can't duplicate them.
  if jsonb_typeof(v_kids) = 'array'
     and not exists (select 1 from public.children where parent_id = p_user_id) then
    for v_kid in select * from jsonb_array_elements(v_kids)
    loop
      -- A malformed date must not abort the whole sign-up.
      begin
        v_dob := (v_kid ->> 'dob')::date;
      exception when others then
        v_dob := null;
      end;

      if nullif(trim(coalesce(v_kid ->> 'name', '')), '') is not null and v_dob is not null then
        insert into public.children (parent_id, name, date_of_birth, gender, interests)
        values (
          p_user_id,
          trim(v_kid ->> 'name'),
          v_dob,
          case when coalesce(v_kid ->> 'gender', '') in ('male', 'female', 'unspecified')
               then v_kid ->> 'gender' else 'unspecified' end,
          coalesce(
            (select array_agg(value::text) from jsonb_array_elements_text(v_kid -> 'interests')),
            '{}'::text[])
        );
      end if;
    end loop;
  end if;
end;
$$;

commit;
