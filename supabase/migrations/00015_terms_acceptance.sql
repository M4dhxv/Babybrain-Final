-- BabyBrain — record explicit Terms & Conditions acceptance (timestamp + version)
-- on the parent profile. Written server-side (service role) at the point of
-- consent. Idempotent.

alter table public.parent_profiles
  add column if not exists terms_accepted_at timestamptz,
  add column if not exists terms_version text;
