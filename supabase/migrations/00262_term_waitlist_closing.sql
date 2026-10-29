-- 00262_term_waitlist_closing.sql
--
-- Closing the term waitlist: Phase 4 of the design agreed with Aman on
-- 29 Oct 2026 (builds on 00259-00261). One job, every 10 minutes:
--
--   1. Decision 4: once a term closes to new families (too few sessions left,
--      mid-term joining off, finished) or is no longer published, everyone
--      still waiting for a place in it is told, once per family, and their
--      entries close. Single sessions are mentioned when the term offers them.
--   2. A trial or single waitlist place on a term session closes when that
--      session's booking window closes, or when the term stops offering that
--      kind of booking. The family is told.
--   3. Decision 6: when a term copied from an earlier one opens to everyone
--      (its returning-family priority window has ended, or 24 hours after it
--      was published when there is no window, so a window the vendor opens
--      just after publishing isn't undercut), families who were waiting on the
--      earlier term get one "it's open" message.
--
-- Term-only: no ordinary class or booking is touched.
--
-- Idempotent.

begin;

alter table public.terms
  add column if not exists waitlist_next_told_at timestamptz;
comment on column public.terms.waitlist_next_told_at is
  'When families waiting on the term this one was copied from were told it is open (close_term_waitlists, 00262).';

create or replace function public.close_term_waitlists()
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  r       record;
  v_quote record;
  v_close boolean;
begin
  -- 1. Term places in a term that no longer takes new families.
  for r in
    select distinct w.slot_id, t.status as term_status, t.name, t.allow_singles, a.title, a.slug
    from public.term_waitlist w
    join public.terms t on t.id = w.term_id
    join public.activities a on a.id = t.activity_id
    where w.status = 'waiting'
  loop
    v_close := r.term_status <> 'published';
    if not v_close then
      select * into v_quote from public.term_quote(r.slot_id);
      v_close := not v_quote.joinable;
    end if;
    continue when not v_close;

    insert into public.notifications (user_id, type, title, body, data)
    select distinct on (w.user_id)
           w.user_id,
           'term_waitlist_closed',
           r.name || ' has closed to new families',
           'No place opened in ' || r.name || ' (' || coalesce(r.title, 'your class') || ') before it closed to new families. '
             || 'You haven''t been charged anything.'
             || case when r.allow_singles and r.term_status = 'published' then ' You can still book single sessions.' else '' end,
           jsonb_build_object(
             'url', case when r.allow_singles and r.term_status = 'published'
                         then '/book?slug=' || coalesce(r.slug, '') || '&mode=single'
                         else '/activity?slug=' || coalesce(r.slug, '') end,
             'term_name', r.name,
             'activity_name', r.title,
             'singles', r.allow_singles and r.term_status = 'published')
    from public.term_waitlist w
    where w.slot_id = r.slot_id and w.status = 'waiting'
    order by w.user_id;

    update public.term_waitlist
       set status = 'closed', ended_at = now(), end_reason = 'The term closed to new families'
     where slot_id = r.slot_id and status = 'waiting';
  end loop;

  -- 2. Trial and single waits on term sessions that can no longer be booked.
  for r in
    with closing as (
      update public.bookings b
         set status = 'cancelled', cancel_reason = 'The waitlist for this session closed'
        from public.activity_sessions s
        join public.term_slots ts on ts.id = s.term_slot_id
        join public.terms t on t.id = ts.term_id
        join public.activities a on a.id = s.activity_id
       where b.session_id = s.id
         and b.status = 'waitlisted'
         and b.term_booking_kind in ('single', 'trial')
         and b.payment_status <> 'paid'
         and b.package_purchase_id is null
         and (s.starts_at - make_interval(mins => coalesce(s.booking_cutoff_minutes, a.booking_cutoff_minutes, 15)) <= now()
              or t.status <> 'published'
              or (b.term_booking_kind = 'single' and not t.allow_singles)
              or (b.term_booking_kind = 'trial' and not t.allow_trial))
      returning b.user_id, b.session_id, a.title, s.starts_at
    )
    select distinct on (c.user_id, c.session_id) c.user_id, c.session_id, c.title, c.starts_at
    from closing c
    where c.user_id is not null
    order by c.user_id, c.session_id
  loop
    insert into public.notifications (user_id, type, title, body, data)
    values (
      r.user_id,
      'term_session_waitlist_closed',
      'The waitlist for ' || coalesce(r.title, 'your class') || ' has closed',
      'No place came free on ' || coalesce(r.title, 'the class') || ', '
        || to_char(r.starts_at at time zone 'Asia/Singapore', 'Dy FMDD Mon, FMHH12:MI am')
        || ', before booking closed. You haven''t been charged anything.',
      public.session_email_details(r.session_id) || jsonb_build_object(
        'url', '/profile?tab=bookings',
        'session_id', r.session_id)
    );
  end loop;

  -- 3. A copied term is open to everyone: tell the earlier term's waiting families.
  for r in
    select t.id, t.name, t.previous_term_id, a.title, a.slug
    from public.terms t
    join public.activities a on a.id = t.activity_id
    where t.status = 'published'
      and t.previous_term_id is not null
      and t.waitlist_next_told_at is null
      and (case when t.priority_until is not null then t.priority_until <= now()
                else coalesce(t.published_at, t.created_at) <= now() - interval '24 hours' end)
  loop
    insert into public.notifications (user_id, type, title, body, data)
    select distinct on (w.user_id)
           w.user_id,
           'term_next_open',
           r.name || ' is open',
           'Enrolment for ' || r.name || ' (' || coalesce(r.title, 'your class') || ') is open to everyone. '
             || 'You were on the waitlist for the term before it, so we wanted you to know first.',
           jsonb_build_object(
             'url', '/book?slug=' || coalesce(r.slug, '') || '&mode=term',
             'term_name', r.name,
             'activity_name', r.title)
    from public.term_waitlist w
    where w.term_id = r.previous_term_id
      and w.status in ('waiting', 'closed')
      and not exists (
        select 1 from public.term_enrolments e
        join public.bookings b on b.term_enrolment_id = e.id
        where e.term_id = r.id and e.user_id = w.user_id and b.status in ('pending', 'confirmed'))
    order by w.user_id;

    update public.terms set waitlist_next_told_at = now() where id = r.id;
  end loop;
end;
$$;

revoke all on function public.close_term_waitlists() from public, anon, authenticated;

-- Every 10 minutes, where pg_cron is installed (it isn't in local tests).
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'close-term-waitlists';
    perform cron.schedule('close-term-waitlists', '*/10 * * * *', 'select public.close_term_waitlists();');
  end if;
end $$;

notify pgrst, 'reload schema';

commit;
