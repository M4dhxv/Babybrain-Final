-- 00169_notification_push_status.sql
--
-- Mirrors email_status (00001) but tracks Web Push instead. Kept as its own
-- column rather than reusing email_status because the two now run on
-- different timelines: chat replies hold the *email* for 8h so an
-- already-open chat doesn't also get an email (00142), but a push should
-- still land immediately — it's the whole point of push. The webhook
-- (app/api/webhooks/notifications) sends push on the first call for a
-- notification, before the chat-delay check, and marks push_status so the
-- 8h-later re-post (which only exists to retry the *email*) doesn't push
-- twice.
--
-- Idempotent.

begin;

alter table public.notifications
  add column if not exists push_status text not null default 'pending'
    check (push_status in ('pending', 'sent', 'skipped', 'failed'));

notify pgrst, 'reload schema';

commit;
