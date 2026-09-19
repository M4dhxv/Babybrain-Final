-- A make-up token a provider issues by hand ("Issue make-up token" on the
-- vendor Bookings page) was a bare INSERT into make_up_tokens: no notification
-- row, so no email and nothing in the parent's Notifications tab. On the free
-- plan that left the parent with no way to learn the token existed at all —
-- Make-up tokens on /profile is Plus-gated, and the product copy on that lock
-- promises "On the free plan they come to you by email".
--
-- The auto-issued path (compensate_cancelled_booking, "Path 2") already writes
-- its own make_up_token_issued notification, so it is skipped here
-- (auto_issued = true) rather than emailed twice. Everything else that lands
-- in make_up_tokens as 'issued' gets one, from the database, so it does not
-- depend on which client (or future code path) did the insert.
--
-- The notification reuses type make_up_token_issued. The email links straight
-- to /book with ?token= — the same deep link as migration 00127 — so a
-- free-tier parent can redeem it without ever opening /profile. `manual` and
-- `expires_on` let the template say the provider issued it and when it lapses,
-- instead of the cancellation wording the auto path uses.

begin;

create or replace function public.notify_manual_make_up_token()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_activity_title text;
  v_activity_slug  text;
  v_provider_name  text;
  v_expires_on     text;
begin
  -- Auto-issued tokens announce themselves; only an 'issued' token held by a
  -- real parent account has anyone to tell.
  if new.auto_issued or new.status <> 'issued' or new.user_id is null then
    return new;
  end if;

  select a.title, a.slug
    into v_activity_title, v_activity_slug
  from public.bookings b
  join public.activity_sessions s on s.id = b.session_id
  join public.activities a on a.id = s.activity_id
  where b.id = new.origin_booking_id;

  select p.business_name into v_provider_name
  from public.providers p
  where p.id = new.provider_id;

  if new.expires_at is not null then
    v_expires_on := to_char(new.expires_at at time zone 'Asia/Singapore', 'FMDD FMMonth YYYY');
  end if;

  insert into public.notifications (user_id, type, title, body, data)
  values (
    new.user_id,
    'make_up_token_issued',
    'Make-up token issued',
    coalesce(v_provider_name, 'Your provider') || ' has issued you a make-up token' ||
      case when v_activity_title is not null then ' for ' || v_activity_title else '' end ||
      case when v_expires_on is not null
           then ' — use it before ' || v_expires_on || '.'
           else ' — it doesn''t expire.' end,
    jsonb_build_object(
      'manual', true,
      'activity_name', v_activity_title,
      'provider_name', v_provider_name,
      'expires_on', v_expires_on,
      'url', case when v_activity_slug is not null
               then '/book?slug=' || v_activity_slug || '&token=' || new.id
               else '/profile?tab=makeup' end,
      'token_id', new.id,
      'booking_id', new.origin_booking_id
    )
  );

  return new;
end;
$$;

drop trigger if exists on_make_up_token_issued_manual on public.make_up_tokens;
create trigger on_make_up_token_issued_manual
  after insert on public.make_up_tokens
  for each row execute function public.notify_manual_make_up_token();

notify pgrst, 'reload schema';

commit;
