-- 00253_platform_feedback.sql
--
-- Parents rating BabyBrain itself (QA: "currently nowhere for parents to leave
-- reviews of the platform"): one star rating (1-5) and an optional comment per
-- account, which they can change later. Separate from public.reviews, which
-- are per activity and shown publicly; this is private feedback for the team,
-- listed in /admin -> Reviews.
--
-- Access: a signed-in user reads, adds and edits only their own row (RLS). No
-- delete from the app, no anon access, no new functions. The admin list reads
-- it with the service role (app/api/admin/platform-feedback).
--
-- Compatibility with the deployed apps (see 00247): a new table nothing reads
-- yet. The parent app's "Rate BabyBrain" card and the admin list both treat a
-- missing table as "nothing yet", so either can ship before this is applied.
--
-- Idempotent.

begin;

create table if not exists public.platform_feedback (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null unique references auth.users (id) on delete cascade,
  rating     smallint not null check (rating between 1 and 5),
  comment    text check (comment is null or char_length(comment) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.platform_feedback is
  'A user''s own rating of BabyBrain (1-5) and optional comment. One row per account, editable by its owner. Read by the admin Reviews tab.';

alter table public.platform_feedback enable row level security;

revoke all on table public.platform_feedback from anon;

drop policy if exists "read own platform feedback" on public.platform_feedback;
create policy "read own platform feedback" on public.platform_feedback
  for select to authenticated using (user_id = auth.uid());

drop policy if exists "add own platform feedback" on public.platform_feedback;
create policy "add own platform feedback" on public.platform_feedback
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists "edit own platform feedback" on public.platform_feedback;
create policy "edit own platform feedback" on public.platform_feedback
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

commit;

notify pgrst, 'reload schema';
