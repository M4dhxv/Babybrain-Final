-- 00074_vendor_qa_scheduling_and_content.sql
--
-- The six vendor QA rows that needed schema, from the 21/08–28/08 sheet.
-- Idempotent.
--
-- A note on 3 and 4 (per-session location and price). The rows ask to "move"
-- location and price off the activity and onto the schedule. They are ADDED to
-- the session rather than moved, and the activity's own values become the
-- default a new session inherits. Moving them outright would strand every
-- existing activity, every Wix-synced service (which carries one price and one
-- location per service), and the parent-side search/filter that reads
-- activities.price. Session values win when set, so a vendor who runs the same
-- class at three venues or three prices now creates ONE activity and varies the
-- schedule — which is what the rows are actually asking for.

-- =============================================================
-- 1. BOOKING CUT-OFF (21/08)
--    "Parents can currently make bookings up until a minute before the class.
--     By default bookings should be able to be made up to 15 minutes before
--     the class starts. Needs to be an option for a vendor to set a cut off."
-- =============================================================
alter table public.activities
  add column if not exists booking_cutoff_minutes integer not null default 15;

alter table public.activities drop constraint if exists activities_booking_cutoff_check;
alter table public.activities add constraint activities_booking_cutoff_check
  check (booking_cutoff_minutes >= 0 and booking_cutoff_minutes <= 20160); -- ≤ 14 days

comment on column public.activities.booking_cutoff_minutes is
  'Minutes before a session starts after which parents can no longer book. 0 = right up to the start time.';

-- =============================================================
-- 2. PER-SESSION PRICE (21/08)
--    "You currently add price on the activity but some providers price
--     activities differently depending on the location."
-- =============================================================
alter table public.activity_sessions
  add column if not exists price numeric;

alter table public.activity_sessions drop constraint if exists activity_sessions_price_check;
alter table public.activity_sessions add constraint activity_sessions_price_check
  check (price is null or price >= 0);

comment on column public.activity_sessions.price is
  'Overrides activities.price for this session. NULL inherits the activity price.';

-- activity_sessions.location_id already exists, so per-session venue needed no
-- column — only the UI to set it and the read paths below to honour it.
comment on column public.activity_sessions.location_id is
  'Overrides activities.location_id for this session. NULL inherits the activity venue.';

-- The effective price of a session, for anything that has to charge for it.
-- SECURITY DEFINER so the checkout route and the booking trigger agree even
-- where RLS would hide one of the rows.
create or replace function public.session_price(p_session uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(s.price, a.price)
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  where s.id = p_session;
$$;

-- =============================================================
-- 3. BESPOKE INFORMATION REQUEST (21/08)
--    "There should be a toggle that when it is slid to on there is a free text
--     box where they can input the type of information they are requesting,
--     such as parents' addresses where classes are hosted at their condo."
-- =============================================================
alter table public.activities
  add column if not exists info_request_enabled boolean not null default false,
  add column if not exists info_request_prompt text;

alter table public.bookings
  add column if not exists info_response text;

comment on column public.activities.info_request_prompt is
  'What the vendor is asking the parent for at booking time, shown above a free-text box.';
comment on column public.bookings.info_response is
  'The parent''s answer to activities.info_request_prompt.';

-- =============================================================
-- 4. VENDOR-EDITABLE BOOKING CONTENT (24/08 + 28/08)
--    "You can't change the information on the activity confirmation screen."
--    "Vendors currently can't edit the message displayed under what to bring
--     & know — this information will vary and it is key."
--    Both were hardcoded in the parent app: every booking showed the same
--    three generic cards and the same music-class blurb.
-- =============================================================
alter table public.activities
  add column if not exists what_to_bring text,
  add column if not exists confirmation_message text;

comment on column public.activities.what_to_bring is
  'Vendor copy for the "What to bring & know" panel. NULL falls back to the generic guidance.';
comment on column public.activities.confirmation_message is
  'Vendor note shown on the post-booking confirmation screen.';

-- =============================================================
-- 5. PROVIDER PHOTOS + VIDEOS (21/08)
--    "Under settings, edit profile, there is nowhere to edit photos/videos.
--     Display photo will be the logo. More photos/videos will be on the
--     profile."
-- =============================================================
alter table public.providers
  add column if not exists gallery_urls text[] not null default '{}',
  add column if not exists video_urls text[] not null default '{}';

comment on column public.providers.gallery_urls is
  'Extra profile photos beyond logo_url (the display photo) and cover_image_url.';
comment on column public.providers.video_urls is
  'Video links (YouTube/Vimeo/direct) shown on the public profile.';

-- =============================================================
-- 6. ENFORCEMENT — extends the existing booking-insert gate.
--    Rebuilt in full (create or replace needs the whole body) from the live
--    definition, with the cut-off, the per-session price and the bespoke
--    information answer added. Everything already there is unchanged.
-- =============================================================
create or replace function public.enforce_booking_insert_defaults()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_price numeric;
  v_paused boolean;
  v_provider uuid;
  v_is_manager boolean := false;
  v_starts_at timestamptz;
  v_cutoff int;
  v_info_enabled boolean;
begin
  if coalesce(auth.role(), '') = 'service_role' then
    return new;  -- trusted server path (Stripe webhook) sets its own state
  end if;

  -- Price now resolves session-first (2), so a per-location price decides
  -- whether this booking is free or has to go through Stripe.
  select coalesce(s.price, a.price), a.bookings_paused, a.provider_id,
         s.starts_at, a.booking_cutoff_minutes, a.info_request_enabled
    into v_price, v_paused, v_provider,
         v_starts_at, v_cutoff, v_info_enabled
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  where s.id = new.session_id;

  v_is_manager := v_provider in (select public.user_manage_provider_ids());

  -- 1.1: parents cannot book a paused class; vendors can still record manual
  -- bookings against it.
  if coalesce(v_paused, false) and not v_is_manager then
    raise exception 'Bookings for this class are currently paused.';
  end if;

  -- 1.2 (00074): the booking cut-off. Vendors are exempt so they can still
  -- record a walk-in at the door, which is exactly when they need to.
  if not v_is_manager
     and v_starts_at is not null
     and v_starts_at - make_interval(mins => coalesce(v_cutoff, 15)) <= now() then
    if coalesce(v_cutoff, 15) = 0 then
      raise exception 'This class has already started.';
    end if;
    raise exception 'Bookings for this class close % minutes before it starts.', coalesce(v_cutoff, 15);
  end if;

  -- 1.3 (00074): if the vendor asks for information at booking, it has to be
  -- answered. Enforced here, not just in the UI, for the same reason the
  -- waiver gate is: the client can be bypassed.
  if coalesce(v_info_enabled, false) and not v_is_manager
     and coalesce(btrim(new.info_response), '') = '' then
    raise exception 'This class needs some extra information before you can book.';
  end if;

  -- Nobody but the server sets Stripe payment state.
  new.amount := null;
  new.stripe_payment_intent := null;

  if v_is_manager and new.guest_name is not null then
    -- 2.1: manual vendor booking — recorded as confirmed (waitlisted if the
    -- capacity trigger put it there); vendors may mark it paid (offline
    -- payment) but never refunded.
    if new.payment_status is null or new.payment_status not in ('none', 'paid') then
      new.payment_status := 'none';
    end if;
    if new.status is distinct from 'waitlisted' then
      new.status := 'confirmed';
      new.waitlist_position := null;
    end if;
  else
    new.payment_status := 'none';
    if new.status = 'waitlisted' then
      null; -- preserve status + position set by handle_booking_insert
    else
      new.waitlist_position := null;
      if coalesce(v_price, 0) = 0 then
        new.status := 'confirmed';   -- free class: nothing to pay
      else
        new.status := 'pending';     -- paid class: Stripe webhook confirms
      end if;
    end if;
  end if;
  return new;
end;
$$;

-- =============================================================
-- 7. Surface the bespoke information answer to the vendor.
--    Collecting it is pointless if the roster can't show it, and the vendor
--    Bookings tab reads this function rather than the table (RLS). Rebuilt
--    from the live definition with `info_response` appended — a new column at
--    the END of the RETURNS TABLE, so the existing positional reads in the
--    frontend keep working.
--    DROP first: Postgres refuses to change a function's return type in place.
-- =============================================================
drop function if exists public.provider_session_roster(uuid);

create or replace function public.provider_session_roster(p_session_id uuid)
returns table(
  booking_id uuid, status text, payment_status text, child_name text,
  child_age_months integer, has_medical boolean, waitlist_position integer,
  attendance_status text, child_id uuid, skill_level text, is_manual boolean,
  user_id uuid, parent_name text, medical_disclosure text,
  policies_accepted integer, info_response text
)
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
  v_provider uuid;
  v_activity uuid;
begin
  select a.provider_id, a.id into v_provider, v_activity
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  where s.id = p_session_id;

  if v_provider is null or v_provider not in (select public.user_provider_ids()) then
    raise exception 'not authorized';
  end if;

  return query
    select b.id,
           b.status,
           b.payment_status,
           public.booking_display_name(c.name, b.guest_name, par.full_name),
           case when c.date_of_birth is not null
                then public.child_age_months(c.date_of_birth) end,
           b.medical_disclosure is not null,
           b.waitlist_position,
           at.status,
           b.child_id,
           sl.level,
           b.guest_name is not null,
           b.user_id,
           par.full_name,
           b.medical_disclosure,
           (select count(*)::int from public.booking_policy_acceptances bpa
             where bpa.booking_id = b.id),
           b.info_response
    from public.bookings b
    left join public.children c on c.id = b.child_id
    left join public.parent_profiles par on par.id = b.user_id
    left join public.attendance at on at.booking_id = b.id
    left join public.child_skill_levels sl on sl.child_id = b.child_id and sl.activity_id = v_activity
    where b.session_id = p_session_id
    order by b.waitlist_position nulls first, b.created_at;
end;
$function$;
