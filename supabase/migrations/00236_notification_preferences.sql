-- 00236_notification_preferences.sql
--
-- Per-category push preferences.
--
-- Until now a parent or vendor could only switch push on or off for a whole
-- device. This adds three server-side switches that apply to every device the
-- person has:
--   push_bookings  - confirmations, cancellations and changes, waitlist spots,
--                    packages; for vendors: new bookings, fully booked, payouts
--   push_messages  - chat replies and support messages
--   push_reminders - reminders before a session and review requests
--
-- No row means everything is on, so nobody has to opt back in. The notifications
-- sender (app/api/webhooks/notifications) reads this before pushing; email is
-- unaffected.
--
-- Reads are RLS-scoped to the owner; writes go through set_push_preferences,
-- which only ever touches the caller's own row (auth.uid()).
--
-- Idempotent.

begin;

create table if not exists public.notification_preferences (
  user_id        uuid primary key references auth.users (id) on delete cascade,
  push_bookings  boolean not null default true,
  push_messages  boolean not null default true,
  push_reminders boolean not null default true,
  updated_at     timestamptz not null default now()
);

alter table public.notification_preferences enable row level security;

drop policy if exists "read own notification preferences" on public.notification_preferences;
create policy "read own notification preferences" on public.notification_preferences
  for select using (user_id = auth.uid());

create or replace function public.set_push_preferences(p_bookings boolean, p_messages boolean, p_reminders boolean)
returns void
language plpgsql
security definer set search_path = public
as $$
declare v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'Not authenticated';
  end if;

  insert into public.notification_preferences (user_id, push_bookings, push_messages, push_reminders, updated_at)
  values (v_user, coalesce(p_bookings, true), coalesce(p_messages, true), coalesce(p_reminders, true), now())
  on conflict (user_id) do update
    set push_bookings = excluded.push_bookings,
        push_messages = excluded.push_messages,
        push_reminders = excluded.push_reminders,
        updated_at = now();
end;
$$;

-- Functions are public by default: only signed-in users may call this one.
revoke all on function public.set_push_preferences(boolean, boolean, boolean) from public, anon;
grant execute on function public.set_push_preferences(boolean, boolean, boolean) to authenticated;

notify pgrst, 'reload schema';

commit;
