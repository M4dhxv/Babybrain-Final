-- 00208_parent_onboarding_completed.sql
--
-- Record when a parent finishes the sign-up wizard.
--
-- parent_profiles.onboarding_completed_at was only ever set by the old Next.js
-- /onboarding page, so every parent created through the current parent-app
-- wizard showed as "not onboarded" in /admin → Parents. The wizard now stamps
-- it client-side when it has a session, and this replaces apply_signup_payload
-- (unchanged from 00094 except for the onboarding_completed_at line) so the
-- email-confirmation path stamps it too.
--
-- Also backfills existing parents who accepted the terms (i.e. completed the
-- wizard) using that acceptance time. Timestamps only; nothing else changes.
-- Idempotent.

begin;

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
         -- Finishing the sign-up wizard is what onboarding is (terms are only sent
         -- once accepted), so stamp it here for the no-session (email confirmation) path.
         onboarding_completed_at = coalesce(onboarding_completed_at,
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

update public.parent_profiles
   set onboarding_completed_at = terms_accepted_at
 where onboarding_completed_at is null
   and terms_accepted_at is not null;

commit;
