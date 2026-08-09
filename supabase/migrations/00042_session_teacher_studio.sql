-- QA: "manage schedule, need to be able to add teacher, studio (some
-- locations have multiple rooms) and you should be able to add a N/A as
-- this isn't relevant for playspaces and community events."
-- Both nullable free-text — leaving them blank is how a vendor expresses
-- "N/A" for activity types (playspaces, community events) where neither
-- concept applies.
alter table public.activity_sessions
  add column if not exists teacher_name text,
  add column if not exists studio text;

notify pgrst, 'reload schema';
