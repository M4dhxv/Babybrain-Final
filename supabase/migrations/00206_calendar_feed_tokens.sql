-- 00206_calendar_feed_tokens.sql
--
-- A parent can subscribe Google / Apple / Outlook Calendar to a private
-- schedule feed (/api/public/calendar-feed/<token>.ics) instead of exporting a
-- one-off .ics file: the calendar app re-reads the feed on its own, so a
-- rescheduled or cancelled booking updates there by itself.
--
-- The feed URL is the credential (calendar apps cannot send a login), so the
-- token is long and random and lives in its own table:
--   * one row per parent; rotating it (new random value) kills the old link;
--   * RLS is on and there are NO policies, and all privileges are revoked from
--     anon / authenticated, so it is reachable only through the service role
--     (the two API routes). Keeping it off parent_profiles also keeps it out of
--     the `select *` the parent app does on the profile.
--
-- Idempotent. ASCII only.

create table if not exists public.calendar_feed_tokens (
  user_id    uuid primary key references public.parent_profiles (id) on delete cascade,
  token      text not null unique,
  created_at timestamptz not null default now()
);

alter table public.calendar_feed_tokens enable row level security;
revoke all on table public.calendar_feed_tokens from public, anon, authenticated;

comment on table public.calendar_feed_tokens is
  'Private calendar-subscription token per parent. Service role only (no RLS policies). See /api/customer/calendar-link and /api/public/calendar-feed/[token].';
