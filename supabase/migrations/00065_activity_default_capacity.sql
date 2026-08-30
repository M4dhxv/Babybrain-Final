-- 00065_activity_default_capacity.sql
--
-- Session capacity became required per session (00043... see the "require
-- session capacity" commit), but there was no way to set a default for an
-- activity — every new session's capacity had to be typed in from scratch,
-- and there's no per-activity value stored anywhere to pre-fill it from.
-- default_capacity lives on the activity and is copied into the capacity
-- field whenever a vendor opens "Add sessions" for it (ActivitiesPage's
-- openSchedule). It does not itself constrain any session's capacity.
alter table public.activities add column if not exists default_capacity integer;
