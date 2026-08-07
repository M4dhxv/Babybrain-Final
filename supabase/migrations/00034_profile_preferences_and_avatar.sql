-- 00034: Area preferences + a changeable avatar.
--
-- QA findings:
--   * "Can we ask on sign up what area parents are interested in — currently we
--     are using postcode for preference. We want to use postcode for near you
--     but we need to ask them preference and recommendations be in those
--     Central, East etc locations."
--   * "Enable parents to change the Avatar through edit profile."
--
-- Avatars are generated from a seed string (animal-avatar-generator), so
-- storing the seed is enough to let a parent pick a different one; null keeps
-- the current behaviour of seeding from their name.

begin;

alter table public.user_preferences
  add column if not exists preferred_regions text[] not null default '{}';

alter table public.parent_profiles
  add column if not exists avatar_seed text;

alter table public.children
  add column if not exists avatar_seed text;

comment on column public.user_preferences.preferred_regions is
  'Singapore areas the parent wants recommendations in (central/east/north/north-east/west/sentosa). Distinct from parent_profiles.postal_code, which powers "near you" distance sorting.';
comment on column public.parent_profiles.avatar_seed is
  'Seed for the generated animal avatar; null falls back to the parent''s name.';

-- These tables use column-level UPDATE grants (not table-wide), so new columns
-- are unwritable by parents until granted explicitly.
grant update (preferred_regions) on public.user_preferences to authenticated;
grant update (avatar_seed)       on public.parent_profiles  to authenticated;
grant update (avatar_seed)       on public.children         to authenticated;
grant insert (avatar_seed)       on public.children         to authenticated;

commit;
