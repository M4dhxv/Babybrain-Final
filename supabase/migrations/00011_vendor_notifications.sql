-- BabyBrain Phase 2 — Booking lifecycle emails (reuses the Phase 1
-- notifications → Resend pipeline). Booking confirmation trigger +
-- reminder + class-follow-up cron jobs. Idempotent.

alter table public.bookings
  add column if not exists reminded_at timestamptz,
  add column if not exists followed_up_at timestamptz;

-- Confirmation: when a booking becomes confirmed, notify the parent once.
create or replace function public.notify_booking_confirmed()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'confirmed' and coalesce(old.status, '') <> 'confirmed' then
    insert into public.notifications (user_id, type, title, body, data)
    select new.user_id, 'booking_confirmed', 'Booking confirmed 🎉',
           'Your booking for ' || a.title || ' is confirmed.',
           jsonb_build_object('url', '/dashboard/bookings', 'booking_id', new.id)
    from public.activity_sessions s
    join public.activities a on a.id = s.activity_id
    where s.id = new.session_id;
  end if;
  return new;
end;
$$;

drop trigger if exists on_booking_confirmed on public.bookings;
create trigger on_booking_confirmed
  after insert or update of status on public.bookings
  for each row execute function public.notify_booking_confirmed();

-- Reminders: confirmed bookings whose session starts in the next 24–36h.
create or replace function public.send_booking_reminders()
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.notifications (user_id, type, title, body, data)
  select b.user_id, 'booking_reminder', 'Class reminder ⏰',
         a.title || ' is coming up on '
           || to_char(s.starts_at at time zone 'Asia/Singapore', 'Dy DD Mon, HH12:MI AM') || '.',
         jsonb_build_object('url', '/dashboard/bookings', 'booking_id', b.id)
  from public.bookings b
  join public.activity_sessions s on s.id = b.session_id
  join public.activities a on a.id = s.activity_id
  where b.status = 'confirmed' and b.reminded_at is null
    and s.starts_at between now() and now() + interval '36 hours';

  update public.bookings b set reminded_at = now()
  from public.activity_sessions s
  where s.id = b.session_id and b.status = 'confirmed' and b.reminded_at is null
    and s.starts_at between now() and now() + interval '36 hours';
end;
$$;

-- Follow-ups: sessions that ended in the last 24h.
create or replace function public.send_class_followups()
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.notifications (user_id, type, title, body, data)
  select b.user_id, 'class_followup', 'How was the class? ⭐',
         'Hope you enjoyed ' || a.title || '! Leave a review to help other families.',
         jsonb_build_object('url', '/activities/' || a.slug, 'activity_id', a.id)
  from public.bookings b
  join public.activity_sessions s on s.id = b.session_id
  join public.activities a on a.id = s.activity_id
  where b.status in ('confirmed','completed') and b.followed_up_at is null
    and s.ends_at between now() - interval '24 hours' and now();

  update public.bookings b set followed_up_at = now()
  from public.activity_sessions s
  where s.id = b.session_id and b.status in ('confirmed','completed')
    and b.followed_up_at is null
    and s.ends_at between now() - interval '24 hours' and now();
end;
$$;

-- Schedule (pg_cron already enabled in Phase 1). Hourly reminders, daily follow-ups.
select cron.unschedule(jobid) from cron.job
 where jobname in ('booking-reminders', 'class-followups');
select cron.schedule('booking-reminders', '0 * * * *', $$select public.send_booking_reminders();$$);
select cron.schedule('class-followups', '0 1 * * *', $$select public.send_class_followups();$$);
