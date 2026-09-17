-- 00139_provider_notification_unread_count.sql
--
-- Unread-count badge on the vendor sidebar's Notifications tab, same
-- treatment the Messages tab already has (UnreadBadge, see
-- frontends/vendor/src/layouts/PortalLayout.tsx). provider_notification_feed
-- (00041) has no read state at all — it's a stateless union of bookings/
-- reviews/tokens re-derived on every call — so there's nothing to count
-- "unread" against without a per-vendor cursor.
--
-- provider_notification_reads is that cursor: one row per (user, provider)
-- recording when this vendor last looked at their Notifications tab.
-- "Unread" = feed events newer than that. Staff are tracked per-user, not
-- per-provider, since multiple staff can share one provider (00006) and each
-- should get their own badge state.
--
-- Both functions upsert-if-missing on first call rather than defaulting a
-- missing row to some point in the past — a brand new cursor seeds itself to
-- now(), so a vendor who's been reading this feed since before this shipped
-- doesn't suddenly see months of "unread" history flood their badge. Only
-- genuinely new events from here on count.

begin;

create table if not exists public.provider_notification_reads (
  user_id uuid not null references auth.users (id) on delete cascade,
  provider_id uuid not null references public.providers (id) on delete cascade,
  last_seen_at timestamptz not null default now(),
  primary key (user_id, provider_id)
);

-- No client-facing policies: every read/write goes through the
-- security-definer functions below (same pattern as provider_notification_feed
-- and friends), so RLS enabled with no policies is a default-deny that's
-- never meant to be worked around from the client.
alter table public.provider_notification_reads enable row level security;

-- 1. The count itself. Mirrors provider_notification_feed's five branches
--    exactly (same tables, same status filters) so the two never disagree
--    about what counts as an event — just a count(*) with a "since" filter
--    instead of a full row fetch, so it stays cheap to poll.
create or replace function public.provider_notification_unread_count(p_provider uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_last_seen timestamptz;
  v_count integer;
begin
  if p_provider not in (select public.user_provider_ids()) then
    raise exception 'not authorized';
  end if;

  insert into public.provider_notification_reads (user_id, provider_id)
  values (auth.uid(), p_provider)
  on conflict (user_id, provider_id) do nothing;

  select last_seen_at into v_last_seen
  from public.provider_notification_reads
  where user_id = auth.uid() and provider_id = p_provider;

  select count(*) into v_count
  from (
    (
      select 1 from public.bookings b
      where b.provider_id = p_provider and b.status in ('confirmed', 'completed')
        and b.created_at > v_last_seen
    )
    union all
    (
      select 1 from public.bookings b
      where b.provider_id = p_provider and b.status = 'waitlisted'
        and b.created_at > v_last_seen
    )
    union all
    (
      select 1 from public.bookings b
      where b.provider_id = p_provider and b.status = 'cancelled'
        and b.updated_at > v_last_seen
    )
    union all
    (
      select 1 from public.reviews r
      join public.activities a on a.id = r.activity_id
      where a.provider_id = p_provider and r.created_at > v_last_seen
    )
    union all
    (
      select 1 from public.make_up_tokens t
      where t.provider_id = p_provider and t.created_at > v_last_seen
    )
  ) unread;

  return v_count;
end;
$$;
grant execute on function public.provider_notification_unread_count(uuid) to authenticated;

-- 2. Marks the feed "seen as of now" — called once when the Notifications
--    tab mounts (NotificationsPage.tsx), which is what clears the badge.
create or replace function public.mark_provider_notifications_seen(p_provider uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_provider not in (select public.user_provider_ids()) then
    raise exception 'not authorized';
  end if;

  insert into public.provider_notification_reads (user_id, provider_id, last_seen_at)
  values (auth.uid(), p_provider, now())
  on conflict (user_id, provider_id) do update set last_seen_at = excluded.last_seen_at;
end;
$$;
grant execute on function public.mark_provider_notifications_seen(uuid) to authenticated;

notify pgrst, 'reload schema';

commit;
