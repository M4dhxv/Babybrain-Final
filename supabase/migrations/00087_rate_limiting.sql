-- 00087_rate_limiting.sql
--
-- A shared, serverless-safe rate limiter (QA fixes 2026-09-02).
--
-- The public /api/contact and /api/vendor/claim/start routes are
-- unauthenticated and each trigger an email/DB write. /contact used an
-- in-process Map keyed by IP, which resets per serverless instance — so on
-- Vercel it barely throttles a distributed caller — and /claim/start had no
-- limit at all, letting an attacker send BabyBrain-branded verification
-- emails to arbitrary addresses and pile up provider_claims rows unbounded.
--
-- This backs a limiter with a table so the count is shared across every
-- instance. `rate_limit_touch` atomically records one hit for a bucket and
-- returns TRUE when that bucket has now exceeded p_max within p_window. The
-- table has RLS enabled with no policies, so only the service role (behind
-- these routes) can touch it.

create table if not exists public.rate_limit_hits (
  id         bigint generated always as identity primary key,
  bucket     text        not null,
  created_at timestamptz not null default now()
);

create index if not exists rate_limit_hits_bucket_time_idx
  on public.rate_limit_hits (bucket, created_at desc);

alter table public.rate_limit_hits enable row level security;
-- No policies: unreachable by anon/authenticated; only the service role writes it.

comment on table public.rate_limit_hits is
  'Serverless-safe rate-limit ledger. One row per request hit; pruned opportunistically by rate_limit_touch. Service-role only (RLS on, no policies).';

/**
 * Record a hit for `p_bucket` and report whether it has exceeded `p_max`
 * within the trailing `p_window`. Atomic (single statement chain in one call),
 * SECURITY DEFINER so the route's service-role client can run it, search_path
 * pinned. Opportunistically prunes this bucket's rows older than the window so
 * the table stays small without a separate cron.
 *
 * Returns TRUE when the caller should be throttled (this hit is over the limit).
 */
create or replace function public.rate_limit_touch(
  p_bucket text,
  p_max    integer,
  p_window interval
) returns boolean
  language plpgsql
  security definer
  set search_path to 'public'
as $function$
declare
  v_count integer;
begin
  -- Drop this bucket's stale hits first so the count and the table stay bounded.
  delete from public.rate_limit_hits
   where bucket = p_bucket and created_at < now() - p_window;

  insert into public.rate_limit_hits (bucket) values (p_bucket);

  select count(*) into v_count
    from public.rate_limit_hits
   where bucket = p_bucket and created_at > now() - p_window;

  return v_count > greatest(p_max, 0);
end;
$function$;

-- The routes call this through the service-role client; keep it off anon/auth.
revoke all on function public.rate_limit_touch(text, integer, interval) from public;
