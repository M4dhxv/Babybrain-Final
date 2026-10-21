-- 00245_push_suggestions_preference.sql
--
-- Suggested activities now go out as a push too (they were email-only, see
-- NO_PUSH_TYPES in app/api/webhooks/notifications), so parents get a fourth
-- switch under Settings → Notifications:
--   push_suggestions - the Tuesday/Thursday "activities picked for you" digest
--
-- On by default, like the other three (no row = everything on). It only ever
-- applies to parents the digest already reaches: Plus, with marketing consent.
--
-- set_push_preferences gains p_suggestions. The old three-argument version is
-- dropped rather than overloaded: two versions differing only by a trailing
-- defaulted argument make PostgREST's call ambiguous. The new argument defaults
-- to null = "leave as it is", so the vendor portal (which still sends three)
-- keeps working unchanged.
--
-- Numbered 00245: 00243/00244 (term enrolment) exist on the test project and the
-- terms-enrolment branch but not on main/production yet.
--
-- Idempotent.

begin;

alter table public.notification_preferences
  add column if not exists push_suggestions boolean not null default true;

drop function if exists public.set_push_preferences(boolean, boolean, boolean);

create or replace function public.set_push_preferences(
  p_bookings    boolean,
  p_messages    boolean,
  p_reminders   boolean,
  p_suggestions boolean default null
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'Not authenticated';
  end if;

  insert into public.notification_preferences (user_id, push_bookings, push_messages, push_reminders, push_suggestions, updated_at)
  values (v_user, coalesce(p_bookings, true), coalesce(p_messages, true), coalesce(p_reminders, true),
          coalesce(p_suggestions, true), now())
  on conflict (user_id) do update
    set push_bookings    = excluded.push_bookings,
        push_messages    = excluded.push_messages,
        push_reminders   = excluded.push_reminders,
        -- null from a caller that doesn't know about this switch keeps what's saved
        push_suggestions = coalesce(p_suggestions, notification_preferences.push_suggestions),
        updated_at       = now();
end;
$$;

-- Functions are public by default: only signed-in users may call this one.
revoke all on function public.set_push_preferences(boolean, boolean, boolean, boolean) from public, anon;
grant execute on function public.set_push_preferences(boolean, boolean, boolean, boolean) to authenticated;

notify pgrst, 'reload schema';

commit;
