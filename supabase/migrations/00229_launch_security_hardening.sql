-- 00229_launch_security_hardening.sql
--
-- Pre-launch audit (8 Oct). Everything here was confirmed against the live
-- database (pg_policies, function ACLs), not just read off the migrations.
-- Nothing changes how booking, waitlist or compensation behave for a parent or
-- a vendor using the apps; each item only closes a door the apps never use.
--
--   1. Internal functions were callable by anyone through the API. Postgres
--      grants EXECUTE to PUBLIC on every new function, and Supabase exposes
--      every public-schema function at /rest/v1/rpc/<name>. Several migrations
--      granted to service_role without revoking the default, so with nothing
--      but the anon key (shipped in the browser bundle) a caller could:
--        * confirm_paid_booking_seats  -> mark their own unpaid booking
--          confirmed + paid, without paying (00180 only ADDED a grant);
--        * send_*_digest / send_*_nudges / send_booking_reminders ... -> make
--          the database email every parent, as often as they liked;
--        * consume_provider_invites(their_id, someone's invited email) -> join
--          that business as staff/manager without owning the address;
--        * rate_limit_touch -> pre-fill any throttle bucket (lock out the
--          claim flow) or grow the table without bound;
--        * compute_recommendations_* -> run the heaviest query we have,
--          unauthenticated, in a loop.
--      All are only ever called by pg_cron, by other security-definer
--      functions, or by server routes holding the service-role key.
--
--   2. provider_overview(provider) returned any business's revenue, booking
--      and waitlist totals to any caller. It now answers members only, like
--      every other provider_* function.
--
--   3. bookings: the "parent creates own booking" INSERT policy let a parent
--      insert a row directly with columns the insert trigger does not reset.
--      package_purchase_id was the costly one: insert a pending booking that
--      names your own pack (no credit is spent), cancel it, and
--      compensate_cancelled_booking hands the pack a credit back - repeatable
--      for unlimited credits. The parent app has only ever booked through
--      book_party / redeem_package_credit / redeem_make_up_token (security
--      definer, unaffected by RLS) and the server routes (service role), so
--      the policy goes. Vendors' manual bookings keep their own policy.
--
--   4. notifications: parents could UPDATE every column of their own rows.
--      Rewriting title/body/data and setting email_status = 'failed' made the
--      retry job re-send it - an email in BabyBrain's name with the caller's
--      text and link. Only read_at is writable now (all the apps ever write).
--      parent_profiles.email is the address those emails go to; a signed-in
--      user can no longer change it (there is no change-email feature).
--
--   5. reviews: a parent could set provider_response on their own review,
--      i.e. write the vendor's reply. Inserts/updates are limited to the four
--      columns the review form sends. Who may review is unchanged (00044).
--
--   6. providers: the unused "create own provider" INSERT policy let any
--      signed-in user publish an active business (with an external booking
--      link) straight onto Explore. Vendors arrive by claiming a listing or
--      being added by an admin, both server-side. And a manager could set
--      their own status / verification_status, undoing a suspension.
--
--   7. activities: a manager could write boosted_until / rating_avg /
--      rating_count / popularity directly - free featured placement and
--      invented ratings. Those columns now ignore signed-in writers.
--
--   8. Storage buckets had no size or type limits.
--
--   9. An email whose webhook call was lost (a deploy in progress, a cold
--      start past pg_net's timeout) stayed 'pending' forever: the retry job
--      only looked at 'failed'. It now also re-posts a non-chat notification
--      still pending after 15 minutes. Chat emails are held on purpose
--      (send_pending_chat_emails) and are left alone.
--
--  10. A parent who restarted checkout on a pending booking could be charged
--      for a seat that was cancelled under them: the first Stripe session's
--      expiry, or the 45-minute clean-up counting from created_at, cancelled
--      the booking while the newer checkout was still open. The checkout
--      route now stamps bookings.checkout_started_at and the clean-up counts
--      from that. (The webhook side is in app/api/webhooks/stripe.)
--
--  11. wix-sync-sweep (every 10 minutes) is the single most expensive
--      statement on the database by total time; a partial index makes it an
--      index probe.
--
-- Apply BEFORE deploying the matching app code. Idempotent. ASCII only.

begin;

-- 1 -------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = any (array[
        'confirm_paid_booking_seats',
        'consume_provider_invites',
        'rate_limit_touch',
        'compute_recommendations_for_child',
        'compute_recommendations_for_parent',
        'suggested_activities_for_parent',
        'group_sibling_notified',
        'send_booking_reminders',
        'send_class_followups',
        'send_package_rebook_nudges',
        'send_package_token_reminders',
        'send_pending_chat_emails',
        'send_providers_added_digest',
        'send_suggested_activities_digest',
        'send_upgrade_nudges'
      ])
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;
end $$;

-- Every NEW function still starts out callable by anon / authenticated (the
-- Postgres + Supabase defaults). A migration that adds a function the apps
-- do not call must revoke it, as above; scripts/check-exposed-functions.mjs
-- lists anything callable that is not on its allowlist.

-- 2 -------------------------------------------------------------------------
create or replace function public.provider_overview(p_provider uuid)
returns table(active_listings integer, upcoming_bookings integer, pending_waitlist integer, profile_views_30d integer, revenue numeric)
language sql
stable security definer
set search_path to 'public'
as $function$
  select
    (select count(*)::int from public.activities
       where provider_id = p_provider and is_published and archived_at is null),
    (select count(*)::int from public.bookings b
       join public.activity_sessions s on s.id = b.session_id
       where b.provider_id = p_provider and b.status = 'confirmed' and s.starts_at > now()),
    (select count(*)::int from public.bookings
       where provider_id = p_provider and status = 'waitlisted'),
    (select count(*)::int from public.listing_events
       where provider_id = p_provider and type in ('profile_view','listing_view')
         and created_at > now() - interval '30 days'),
    (select coalesce(sum(amount), 0) from public.bookings
       where provider_id = p_provider and payment_status = 'paid')
  -- Members of this business only; anyone else gets no row.
  where p_provider in (select public.user_provider_ids());
$function$;

revoke all on function public.provider_overview(uuid) from public, anon;
grant execute on function public.provider_overview(uuid) to authenticated, service_role;

-- 3 -------------------------------------------------------------------------
drop policy if exists "parent creates own booking" on public.bookings;

-- 4 -------------------------------------------------------------------------
revoke update on table public.notifications from anon, authenticated;
grant update (read_at) on table public.notifications to authenticated;

create or replace function public.protect_parent_email()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  -- The address every notification email is sent to. It is written at sign-up
  -- (handle_new_user) and by the server; a signed-in user cannot repoint it.
  if coalesce(auth.role(), '') in ('authenticated', 'anon')
     and new.email is distinct from old.email then
    new.email := old.email;
  end if;
  return new;
end;
$function$;

drop trigger if exists protect_parent_email on public.parent_profiles;
create trigger protect_parent_email
  before update on public.parent_profiles
  for each row execute function public.protect_parent_email();

-- 5 -------------------------------------------------------------------------
revoke insert, update on table public.reviews from anon, authenticated;
grant insert (user_id, activity_id, rating, comment) on table public.reviews to authenticated;
grant update (user_id, activity_id, rating, comment) on table public.reviews to authenticated;

-- 6 -------------------------------------------------------------------------
drop policy if exists "create own provider" on public.providers;

create or replace function public.providers_guard_moderation_columns()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  -- Service role, cron and the SQL editor have no auth.uid(); they pass.
  if auth.uid() is null then
    return new;
  end if;
  if new.status is distinct from old.status
     or new.verification_status is distinct from old.verification_status
     or coalesce(new.is_test, false) is distinct from coalesce(old.is_test, false)
     or coalesce(new.is_auto_listed, false) is distinct from coalesce(old.is_auto_listed, false)
  then
    raise exception 'status / verification on provider % are set by BabyBrain, not by a signed-in user', old.id
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$function$;

drop trigger if exists providers_guard_moderation on public.providers;
create trigger providers_guard_moderation
  before update on public.providers
  for each row execute function public.providers_guard_moderation_columns();

-- 7 -------------------------------------------------------------------------
create or replace function public.activities_guard_ranking_columns()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  -- Service role and cron have no auth.uid(). A nested write is another
  -- trigger doing its job in a signed-in user's transaction (a parent's
  -- review refreshing the rating through refresh_activity_rating); only a
  -- direct write from a signed-in user is depth 1.
  if auth.uid() is null or pg_trigger_depth() > 1 then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.boosted_until := null;
    new.rating_avg := 0;
    new.rating_count := 0;
    new.popularity := 0;
  else
    new.boosted_until := old.boosted_until;
    new.rating_avg := old.rating_avg;
    new.rating_count := old.rating_count;
    new.popularity := old.popularity;
  end if;
  return new;
end;
$function$;

drop trigger if exists activities_guard_ranking on public.activities;
create trigger activities_guard_ranking
  before insert or update on public.activities
  for each row execute function public.activities_guard_ranking_columns();

-- 8 -------------------------------------------------------------------------
-- The apps already keep to these (vendor uploads: 5 MB images; policy
-- documents: PDF or image); this makes the bucket refuse anything else.
-- Existing objects are not touched. In its own block so a storage-schema
-- permission difference can never fail the rest of this migration.
do $$
begin
  update storage.buckets
     set file_size_limit = 10485760, allowed_mime_types = array['image/*']
   where id = 'activity-images';
  update storage.buckets
     set file_size_limit = 15728640, allowed_mime_types = array['application/pdf', 'image/*']
   where id = 'provider-policies';
exception when others then
  raise warning '00229: storage bucket limits not applied (%). Set them in the dashboard.', sqlerrm;
end $$;

-- 9 -------------------------------------------------------------------------
create or replace function public.retry_failed_notification_emails()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_secret text;
  v_id     uuid;
  v_n      int := 0;
begin
  select decrypted_secret into v_secret
    from vault.decrypted_secrets
    where name = 'cron_shared_secret';
  if v_secret is null or v_secret = '' then
    return 0;  -- same guard as notify_email_webhook(): not configured here
  end if;

  for v_id in
    update public.notifications
       set email_status = 'pending',
           email_attempts = email_attempts + 1
     where id in (
       select id from public.notifications
        where email_attempts < 3
          and created_at > now() - interval '24 hours'
          and (
            email_status = 'failed'
            -- 00229: the webhook call itself was lost, so nothing ever moved
            -- this row off 'pending'. Chat emails wait on purpose and have
            -- their own job (send_pending_chat_emails).
            or (email_status = 'pending'
                and created_at < now() - interval '15 minutes'
                and type not in ('provider_message', 'provider_message_response',
                                 'class_group_message', 'provider_class_group_message'))
          )
        order by created_at
        limit 50
        for update skip locked
     )
    returning id
  loop
    perform net.http_post(
      url     := public.app_base_url() || '/api/webhooks/notifications',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-webhook-secret', v_secret
      ),
      body    := jsonb_build_object('notification_id', v_id)
    );
    v_n := v_n + 1;
  end loop;

  return v_n;
end;
$function$;

revoke all on function public.retry_failed_notification_emails() from public, anon, authenticated;

-- 10 ------------------------------------------------------------------------
alter table public.bookings add column if not exists checkout_started_at timestamptz;
comment on column public.bookings.checkout_started_at is
  'When the parent last opened Stripe Checkout for this unpaid booking. The stale clean-up counts its 45 minutes from here, so a restarted checkout is not cancelled while it is still open.';

create or replace function public.release_stale_pending_bookings()
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r record;
begin
  -- A claim hold that wasn't paid for goes back to the waitlist, keeping its
  -- place, and everyone else hears the spot is free again.
  for r in
    with released as (
      update public.bookings
         set status = 'waitlisted', pending_since = null
       where status = 'pending'
         and payment_status = 'none'
         and pending_since is not null
         and greatest(pending_since, coalesce(checkout_started_at, pending_since))
               < now() - interval '45 minutes'
      returning session_id
    )
    select distinct session_id from released
  loop
    perform public.notify_waitlist_all_open(r.session_id);
  end loop;

  -- An ordinary unpaid booking is cancelled, as before - 45 minutes after the
  -- parent last opened checkout (00229), and never held open past 6 hours by
  -- reopening it.
  update public.bookings
     set status = 'cancelled'
   where status = 'pending'
     and payment_status = 'none'
     and pending_since is null
     and (coalesce(checkout_started_at, created_at) < now() - interval '45 minutes'
          or created_at < now() - interval '6 hours');
end;
$function$;

revoke all on function public.release_stale_pending_bookings() from public, anon, authenticated;

-- 11 ------------------------------------------------------------------------
create index if not exists wix_sync_runs_running_idx
  on public.wix_sync_runs (started_at) where status = 'running';

notify pgrst, 'reload schema';

commit;
