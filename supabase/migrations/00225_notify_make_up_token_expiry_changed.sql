-- A vendor changing a make-up token's expiry ("Set expiry" on the vendor
-- Make-up tokens page) is a bare UPDATE of make_up_tokens, so the parent was
-- never told — unlike a package's expiry, which provider_set_purchase_expiry
-- (00170/00192) already notifies. Do it from the database so it holds for any
-- client. The notification carries token_id and the same /book?...&token= deep
-- link the issue notification uses, so tapping it opens that exact token
-- (Plus parents land on their Make-up tokens tab with the row highlighted; see
-- notificationTarget in the parent ProfilePage).
--
-- Only a live token held by a real parent is announced, and only when the
-- expiry actually changed (the cron that stamps status 'expired' leaves
-- expires_at alone, so it does not fire this).

begin;

create or replace function public.notify_make_up_token_expiry_changed()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_activity_title text;
  v_activity_slug  text;
  v_provider_name  text;
begin
  if new.expires_at is not distinct from old.expires_at
     or new.user_id is null
     or new.status = 'redeemed' then
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

  insert into public.notifications (user_id, type, title, body, data)
  values (
    new.user_id,
    'make_up_token_expiry_changed',
    'Make-up token validity updated',
    coalesce(v_provider_name, 'Your provider') || ' updated the validity of your make-up token' ||
      case when v_activity_title is not null then ' for ' || v_activity_title else '' end ||
      case when new.expires_at is not null
           then ' — now valid until ' || to_char(new.expires_at at time zone 'Asia/Singapore', 'FMDD FMMonth YYYY') || '.'
           else ' — it no longer expires.' end,
    jsonb_build_object(
      'activity_name', v_activity_title,
      'provider_name', v_provider_name,
      'expires_on', case when new.expires_at is not null
                      then to_char(new.expires_at at time zone 'Asia/Singapore', 'FMDD FMMonth YYYY') end,
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

drop trigger if exists on_make_up_token_expiry_changed on public.make_up_tokens;
create trigger on_make_up_token_expiry_changed
  after update of expires_at on public.make_up_tokens
  for each row execute function public.notify_make_up_token_expiry_changed();

notify pgrst, 'reload schema';

commit;
