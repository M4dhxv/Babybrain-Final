-- 00147_class_chat_booking_sync.sql
--
-- Class group chats are per slot (session). A parent's access follows their
-- booking: cancel -> out of that slot's group; reschedule -> out of the old
-- slot, in the new one on next open. The route /api/chat/class-group re-syncs
-- every time the parent opens the chat (the safety net); this trigger makes
-- revocation immediate, for every code path that touches bookings (portal
-- cancel, refund, Wix-dropped session, parent reschedule, ...).
-- Same pg_net + Vault pattern as notify_email_webhook (00023). No secret ->
-- no-op, and the open-time sync still enforces access.

begin;

create or replace function public.bookings_chat_sync()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_secret text;
  v_sessions jsonb;
begin
  if new.user_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and old.status is not distinct from new.status
     and old.session_id is not distinct from new.session_id then
    return new;
  end if;

  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'cron_shared_secret';
  if v_secret is null or v_secret = '' then
    return new;
  end if;

  v_sessions := to_jsonb(array(
    select distinct s from unnest(
      case when tg_op = 'UPDATE' then array[old.session_id, new.session_id]
           else array[new.session_id] end
    ) as s where s is not null
  ));

  begin
    perform net.http_post(
      url     := 'https://babybrain-final.vercel.app/api/webhooks/booking-chat',
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', v_secret),
      body    := jsonb_build_object('user_id', new.user_id, 'session_ids', v_sessions)
    );
  exception when others then
    -- Never let a chat-sync hiccup block a booking write.
    raise warning 'bookings_chat_sync failed: %', sqlerrm;
  end;
  return new;
end;
$$;

drop trigger if exists bookings_chat_sync on public.bookings;
create trigger bookings_chat_sync
  after insert or update of status, session_id on public.bookings
  for each row execute function public.bookings_chat_sync();

commit;
