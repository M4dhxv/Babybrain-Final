-- 00179_stale_pending_sweep_5min.sql
--
-- Tightens the abandoned-checkout sweep (00172) from every 15 minutes to
-- every 5. This job is a plain SQL UPDATE run by pg_cron directly against
-- this database — no net.http_post, no Edge Function invocation — so unlike
-- wix-sync (00083, intentionally widened to /15 to cut Edge Function
-- invocation billing) there is no per-invocation cost here to weigh; this is
-- purely a freshness improvement. The 45-minute abandonment threshold itself
-- is unchanged — a stale 'pending' row now waits at most ~5 extra minutes
-- past that mark before being cancelled, instead of up to ~15.
--
-- Idempotent.

select cron.unschedule(jobid) from cron.job
 where jobname = 'cancel-stale-pending-bookings';

select cron.schedule('cancel-stale-pending-bookings', '*/5 * * * *', $$
  update public.bookings
  set status = 'cancelled'
  where status = 'pending'
    and payment_status = 'none'
    and created_at < now() - interval '45 minutes';
$$);
