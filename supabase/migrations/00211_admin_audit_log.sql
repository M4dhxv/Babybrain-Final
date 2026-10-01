-- 00211_admin_audit_log.sql
--
-- A record of who changed what in the admin portal.
--
-- Admin actions (marking a parent or vendor as test, editing commission terms, creating or
-- editing a vendor, running a sync) change live data, and until now left no trace of who did
-- them or when. Each of those now writes one row here. Only the service role (the admin API)
-- can read or write it; there are deliberately no RLS policies, so no signed-in app user can
-- see it.
--
-- Idempotent.

begin;

create table if not exists public.admin_audit_log (
  id           bigint generated always as identity primary key,
  at           timestamptz not null default now(),
  actor_email  text not null,
  actor_role   text,
  action       text not null,        -- e.g. parent.mark_test, vendor.update, commercials.update
  entity_type  text,                 -- parent | vendor | commercials | sync
  entity_id    text,
  summary      text not null,
  details      jsonb
);

create index if not exists admin_audit_log_at_idx on public.admin_audit_log (at desc);
create index if not exists admin_audit_log_entity_idx on public.admin_audit_log (entity_type, entity_id);

alter table public.admin_audit_log enable row level security;
revoke all on table public.admin_audit_log from anon, authenticated;

comment on table public.admin_audit_log is
  'Who changed what in /admin. Written and read only by the admin API (service role).';

commit;
