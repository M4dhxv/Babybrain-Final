import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import {
  fetchWixServices,
  fetchWixResources,
  fetchWixLocations,
  fetchWixAvailability,
  fetchWixClassSessionList,
  fetchWixSessionLiveness,
  fetchWixCourseSpan,
  fetchWixConfirmedAppointmentBookings,
  fetchWixBookingStatuses,
  encodeWixSlotKey,
  decodeWixSlotKey,
  type WixSlotKey,
  wixServicePrice,
  wixServiceCapacity,
  wixServiceImageUrl,
  wixLocalToUtcIso,
  wixSlotStaff,
  formatWixStaffNames,
  selectNonOverlappingSlots,
  type WixCredentials,
  type WixService,
  type WixLocation,
  type WixTimeSlot,
  type WixClassSession,
  type WixConfirmedBooking,
} from './wix-client.ts';

/**
 * Deno port of syncWixServicesToActivities from lib/wix/sync.ts — the
 * refresh-only half the scheduled sync actually calls (no `onlyServiceIds`,
 * so it never creates a new activity, only keeps already-imported ones in
 * step — see the comment on the loop below, ported unchanged). The
 * create-new-listing path, unlinkWixActivities, and every booking-adjacent
 * function in the original file are deliberately not ported here — they're
 * only ever reached from an authenticated vendor session, which stays on
 * Vercel.
 *
 * Types use `SupabaseClient` with no generic — the Deno copy doesn't carry
 * types/database.ts's ~1400-line generated types, so table/column names
 * aren't compile-time checked here the way the Vercel original is. Correct
 * column names still matter at runtime; keep this in step with
 * lib/wix/sync.ts by eye (or diff) rather than relying on the type checker
 * to catch drift.
 */

export interface WixServiceSyncResult {
  created: number;
  updated: number;
  skipped: { name: string; reason: string }[];
  removed: number;
  revived: number;
}

async function resolveWixServiceLocation(
  admin: SupabaseClient,
  providerId: string,
  service: WixService,
  wixLocationsById: Map<string, WixLocation>,
  cache: Map<string, string | null>
): Promise<{ locationId: string | null; address: string | null; postalCode: string | null }> {
  const loc =
    service.locations?.find((l) => l.type === 'BUSINESS') ??
    service.locations?.find((l) => l.type === 'CUSTOM');
  if (!loc) return { locationId: null, address: null, postalCode: null };

  const known = wixLocationsById.get(loc.id);
  const address = known?.address ?? loc.calculatedAddress?.formattedAddress ?? null;
  const postalCode = known?.postalCode ?? loc.calculatedAddress?.postalCode ?? null;

  if (cache.has(loc.id)) return { locationId: cache.get(loc.id)!, address, postalCode };

  const { data: existing } = await admin
    .from('provider_locations')
    .select('id')
    .eq('provider_id', providerId)
    .eq('wix_location_id', loc.id)
    .maybeSingle();
  if (existing) {
    cache.set(loc.id, existing.id);
    return { locationId: existing.id, address, postalCode };
  }

  const { count } = await admin
    .from('provider_locations')
    .select('id', { count: 'exact', head: true })
    .eq('provider_id', providerId);

  const { data: created } = await admin
    .from('provider_locations')
    .insert({
      provider_id: providerId,
      name: known?.name ?? address ?? 'Wix location',
      address,
      postal_code: postalCode,
      wix_location_id: loc.id,
      is_primary: (count ?? 0) === 0,
    })
    .select('id')
    .single();
  cache.set(loc.id, created?.id ?? null);
  return { locationId: created?.id ?? null, address, postalCode };
}

/** Not needed on the refresh-only path (nothing new is created here), kept
 *  only because syncWixServicesToActivities's create branch is ported for
 *  fidelity even though onlyServiceIds is never passed by the scheduled
 *  caller — dead code on this path today, cheap to keep in step. */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'wix-service';
}

/** See lib/wix/sync.ts's importWixSessionStaff — identical logic. */
async function importWixSessionStaff(
  admin: SupabaseClient,
  activityId: string,
  staffBySlotKey: Map<string, string | null>
): Promise<number> {
  if ([...staffBySlotKey.values()].every((name) => !name)) return 0;

  const { data: rows, error: readError } = await admin
    .from('activity_sessions')
    .select('id, wix_slot_key, teacher_name')
    .eq('activity_id', activityId)
    .not('wix_slot_key', 'is', null);
  if (readError) {
    console.error('Wix session staff import could not read the schedule', activityId, readError);
    return 0;
  }

  const idsByName = new Map<string, string[]>();
  for (const row of rows ?? []) {
    const name = staffBySlotKey.get(row.wix_slot_key as string);
    if (!name || row.teacher_name === name) continue;
    const ids = idsByName.get(name);
    if (ids) ids.push(row.id);
    else idsByName.set(name, [row.id]);
  }
  if (idsByName.size === 0) return 0;

  let updated = 0;
  for (const [name, ids] of idsByName) {
    for (let i = 0; i < ids.length; i += 100) {
      const { data, error } = await admin
        .from('activity_sessions')
        .update({ teacher_name: name })
        .in('id', ids.slice(i, i + 100))
        .select('id');
      if (error) {
        console.error('Wix session staff import failed', activityId, error);
        continue;
      }
      updated += data?.length ?? 0;
    }
  }
  return updated;
}

/** Everything {@link cancelWixDroppedSession} needs to prove Wix really dropped
 *  a session. `listComplete` is whether the calendar read that produced the
 *  "current keys" saw every page (see fetchWixClassSessionList): absence from a
 *  truncated list proves nothing. */
interface WixDroppedSessionContext {
  creds: WixCredentials;
  listComplete: boolean;
}

/** A vendor cancelling a class occurrence on Wix leaves no marker in the list
 *  we sync — the session just stops being returned. Until now that was treated
 *  as "keep it if anyone booked", so the booking, the parent's calendar date
 *  and the vendor's schedule all carried on as if the class still ran.
 *
 *  This is where such a session is finally cancelled, and it is deliberately
 *  conservative because the consequence is emails to real parents. It acts only
 *  when ALL of these hold:
 *    1. the calendar read was complete (never infer a cancellation from a
 *       truncated list),
 *    2. the occurrence is still in the future (a class that already happened
 *       and later fell out of the window is history, not a cancellation),
 *    3. it is a class-occurrence key (not an appointment slot, not a course
 *       anchor), and
 *    4. Wix, asked about that exact session, says it is cancelled or gone —
 *       not merely "absent from a list". An inconclusive answer (timeout, 5xx,
 *       odd status) does nothing; the next sync simply tries again.
 *  The cancel itself is one database function (cancel_wix_session, migration
 *  00146) so the bookings, notifications, emails and make-up credit all go
 *  through the same triggers a vendor's own portal cancellation uses. */
async function cancelWixDroppedSession(
  admin: SupabaseClient,
  session: { id: string; wix_slot_key: string; starts_at: string },
  ctx: WixDroppedSessionContext
): Promise<void> {
  if (!ctx.listComplete) return;
  if (new Date(session.starts_at).getTime() <= Date.now()) return;
  let key: WixSlotKey;
  try {
    key = decodeWixSlotKey(session.wix_slot_key);
  } catch {
    return;
  }
  if (key.kind !== 'class') return;

  const liveness = await fetchWixSessionLiveness(ctx.creds, key.sessionId);
  if (liveness !== 'cancelled') return;

  const { data, error } = await admin.rpc('cancel_wix_session', { p_session_id: session.id });
  if (error) {
    console.error('Wix dropped-session cancel failed', session.id, error);
    return;
  }
  console.log(`Wix cancelled session ${session.id} (${session.starts_at}) — cancelled ${data ?? 0} booking(s)`);
}

/** See lib/wix/sync.ts's reconcileStaleWixSessions (moved there from
 *  app/api/wix/slots/route.ts) — identical logic. */
async function reconcileStaleWixSessions(
  admin: SupabaseClient,
  activityId: string,
  currentKeys: Set<string>,
  windowStart: Date,
  windowEnd: Date,
  // Class/course occurrences only: how to prove Wix cancelled a kept session
  // (see cancelWixDroppedSession). Omitted for appointments, whose slots come
  // and go with availability and are never "cancelled" by a vendor this way.
  dropped?: WixDroppedSessionContext
): Promise<void> {
  const { data: existing } = await admin
    .from('activity_sessions')
    .select('id, wix_slot_key, wix_remaining_capacity, capacity, starts_at')
    .eq('activity_id', activityId)
    .not('wix_slot_key', 'is', null)
    // A COURSE enrolment's anchor row (wix_slot_key 'wixcourse:<scheduleId>')
    // isn't one of the per-occurrence slots this fetch enumerates — it spans
    // the whole run and is managed at booking time — so it must never be
    // treated as a stale occurrence and swept.
    .not('wix_slot_key', 'like', 'wixcourse:%')
    // Already cancelled by an earlier pass: settled, and its (cancelled)
    // bookings still reference it so it can never be deleted anyway.
    .neq('status', 'cancelled')
    .gte('starts_at', windowStart.toISOString())
    .lt('starts_at', windowEnd.toISOString());
  const stale = (existing ?? []).filter((s: any) => !currentKeys.has(s.wix_slot_key!));
  if (stale.length === 0) return;

  const { data: bookings } = await admin
    .from('bookings')
    .select('session_id, status')
    .in('session_id', stale.map((s: any) => s.id));
  const bookedSessionIds = new Set(
    (bookings ?? []).filter((b: any) => b.status !== 'cancelled').map((b: any) => b.session_id)
  );

  for (const s of stale) {
    // Wix's own remaining-capacity snapshot from the last time this slot was
    // fetched is the other signal a real seat is filled (a class booked
    // directly on Wix's own site, not just through BabyBrain).
    const bookedOnWix = s.wix_remaining_capacity != null && s.capacity != null && s.wix_remaining_capacity < s.capacity;
    const hasLocalBooking = bookedSessionIds.has(s.id);
    if (!hasLocalBooking && !bookedOnWix) {
      // A row re-keyed `wixbooking:<id>` by reconcileRescheduledWixAppointments
      // is the moved appointment's own row. Once its booking is cancelled it is
      // stale (Wix never lists that synthetic key), but the cancelled booking
      // still references it, so the delete below fails silently and the row
      // stayed `scheduled` — a phantom open slot beside the real one. Settle
      // it as cancelled instead. Scoped to this key prefix: Wix can never
      // re-offer it, whereas a normal slot key can come back and the upsert
      // does not reset `status`.
      if (s.wix_slot_key!.startsWith('wixbooking:')) {
        await admin.from('activity_sessions').update({ status: 'cancelled' }).eq('id', s.id);
        continue;
      }
      await admin.from('activity_sessions').delete().eq('id', s.id);
      continue;
    }
    // Kept for a real local booking, but Wix no longer offers this occurrence
    // at all (the vendor dropped the day, changed the recurrence, cancelled it,
    // etc.) — so wix_remaining_capacity is now a frozen snapshot from before
    // that happened, not live truth, and nothing will ever refresh it again
    // since future fetches simply won't see this slot to upsert. Left alone it
    // permanently overstates "booked" on the vendor's capacity badge
    // (computeWixAwareCapacity takes the max of this and the local held
    // count). Clearing it makes the badge fall back to the local held count,
    // the only figure still honest once Wix itself has stopped tracking it.
    if (hasLocalBooking && s.wix_remaining_capacity != null) {
      await admin.from('activity_sessions').update({ wix_remaining_capacity: null }).eq('id', s.id);
    }
    // Kept rather than deleted — but if Wix confirms the vendor cancelled it,
    // cancel it here too: the parents' bookings, their emails, and the
    // session's visibility all follow from that.
    if (dropped) {
      await cancelWixDroppedSession(admin, s as { id: string; wix_slot_key: string; starts_at: string }, dropped);
    }
  }
}

/** A vendor cancelling an APPOINTMENT on Wix used to leave the parent's
 *  booking `confirmed` here forever: nothing looked at Wix's booking status
 *  (reconcileRescheduledWixAppointments only follows CONFIRMED bookings), and
 *  the freed slot simply reappeared as bookable. Asks Wix for the current
 *  status of every upcoming locally-held Wix appointment booking and cancels
 *  the ones Wix reports CANCELED as a VENDOR cancellation (`cancelled_by`
 *  set), the same stamp cancel_wix_session uses: that is what makes
 *  notify_booking_cancelled send the class_cancelled email and
 *  compensate_cancelled_booking (00080) issue the make-up token / return the
 *  pack credit. Only the booking is cancelled, not its session — unlike a
 *  dropped class occurrence the slot is still real and Wix re-offers it, so
 *  the ordinary upsert keeps it bookable. A booking Wix doesn't return, or a
 *  failed lookup, is left alone (the next sync tries again). Idempotent: only
 *  pending/confirmed/waitlisted rows are touched. */
async function cancelWixCancelledAppointmentBookings(
  admin: SupabaseClient,
  activityId: string,
  creds: WixCredentials
): Promise<void> {
  const { data: rows } = await admin
    .from('bookings')
    .select('id, wix_booking_id, activity_sessions!inner(activity_id, starts_at)')
    .eq('activity_sessions.activity_id', activityId)
    .gt('activity_sessions.starts_at', new Date().toISOString())
    .not('wix_booking_id', 'is', null)
    .in('status', ['pending', 'confirmed', 'waitlisted']);
  if (!rows?.length) return;

  let statuses: Map<string, string>;
  try {
    statuses = await fetchWixBookingStatuses(creds, rows.map((r) => r.wix_booking_id as string));
  } catch (e) {
    console.error('Wix appointment cancellation check failed', activityId, e);
    return;
  }
  const cancelled = rows.filter((r) => {
    const s = statuses.get(r.wix_booking_id as string);
    return s === 'CANCELED' || s === 'CANCELED_MANUALLY' || s === 'DECLINED';
  });
  if (cancelled.length === 0) return;

  // There is no portal user here, so borrow the provider's owner, then any
  // member, then a nil uuid so the flag is never null — same fallback order as
  // cancel_wix_session (00146).
  const { data: act } = await admin
    .from('activities')
    .select('provider_id, providers(owner_id)')
    .eq('id', activityId)
    .maybeSingle();
  const providerId = (act as any)?.provider_id as string | undefined;
  let actor: string | null = (act as any)?.providers?.owner_id ?? null;
  if (!actor && providerId) {
    const { data: m } = await admin
      .from('provider_members')
      .select('user_id')
      .eq('provider_id', providerId)
      .not('user_id', 'is', null)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    actor = (m as any)?.user_id ?? null;
  }
  actor ??= '00000000-0000-0000-0000-000000000000';

  for (const r of cancelled) {
    const { error } = await admin
      .from('bookings')
      .update({
        status: 'cancelled',
        cancel_refund_mode: 'refund',
        cancel_reason: 'Appointment cancelled by the provider on Wix',
        cancelled_by: actor,
      })
      .eq('id', r.id)
      .in('status', ['pending', 'confirmed', 'waitlisted']);
    if (error) console.error('Wix appointment cancel failed', r.id, error);
  }
}

/** See lib/wix/sync.ts's reconcileRescheduledWixAppointments — identical
 *  logic (ported the same way everything else in this file is). A vendor
 *  moving an already-booked APPOINTMENT's time on Wix has no stable
 *  per-slot id to upsert against, so the ordinary key-based upsert below
 *  inserts a brand-new row at the new time and reconcileStaleWixSessions is
 *  deliberately guarded from deleting the old, still-booked one — the
 *  booking silently kept pointing at a session row with the WRONG time
 *  forever, and on_session_rescheduled (00126) never fired, so no email
 *  went out. Matches on the one thing that IS stable across a Wix
 *  reschedule — the booking's own id — and updates the row in place when
 *  Wix's time has moved, a real UPDATE that fires the trigger. */
async function reconcileRescheduledWixAppointments(
  admin: SupabaseClient,
  activityId: string,
  confirmedBookings: WixConfirmedBooking[]
): Promise<void> {
  const wixTimeByBookingId = new Map(confirmedBookings.map((b) => [b.id, b]));
  if (wixTimeByBookingId.size === 0) return;

  const { data: rows } = await admin
    .from('bookings')
    .select('wix_booking_id, activity_sessions!inner(id, activity_id, starts_at, ends_at)')
    .eq('activity_sessions.activity_id', activityId)
    .not('wix_booking_id', 'is', null)
    .in('status', ['pending', 'confirmed', 'waitlisted']);

  for (const row of (rows ?? []) as any[]) {
    const wixBookingId = row.wix_booking_id as string | null;
    if (!wixBookingId) continue;
    const wix = wixTimeByBookingId.get(wixBookingId);
    if (!wix) continue;

    const session = row.activity_sessions as { id: string; activity_id: string; starts_at: string; ends_at: string };
    if (
      new Date(wix.start).getTime() === new Date(session.starts_at).getTime() &&
      new Date(wix.end).getTime() === new Date(session.ends_at).getTime()
    ) continue;

    const { error } = await admin
      .from('activity_sessions')
      // wix_slot_key must move too — see lib/wix/sync.ts's identical comment.
      // Leaving the old key meant the freed-up old time (now bookable again
      // on Wix) got key-matched back onto this row by the ordinary upsert a
      // few lines below, silently undoing this correction.
      .update({ starts_at: wix.start, ends_at: wix.end, wix_slot_key: `wixbooking:${wixBookingId}` })
      .eq('id', session.id);
    if (error) console.error('Wix appointment reschedule reconcile failed', session.id, error);
  }
}

interface WixSlotActivity {
  id: string;
  wix_service_id: string;
  wix_resource_id: string | null;
  wix_service_type: string | null;
}

type WixAvailabilitySyncResult =
  | { kind: 'class'; sessions: WixClassSession[]; courseSpan: { start: string; end: string } | null }
  | { kind: 'appointment'; slots: WixTimeSlot[] };

/** How far ahead the class-session refresh has to look for THIS activity.
 *  The cron's base window is short (14 days for a CLASS), but a parent can hold
 *  a booking on an occurrence well beyond it. If the vendor moves such an
 *  occurrence on Wix, a window that doesn't reach it never sees the new time:
 *  the booked row stays stale (Wix still lists the session, so it is not
 *  "dropped") and `on_session_rescheduled` doesn't fire until the date finally
 *  comes inside the window, about two weeks before the class, if ever. So the
 *  window is stretched to the furthest occurrence with an active booking, plus
 *  a margin so a move a few weeks later is still inside it. Capped so one odd
 *  far-future booking can't turn every sync into a huge fetch. CLASS only: a
 *  COURSE's booked row is an anchor spanning the whole run, not an occurrence. */
const BOOKED_CLASS_WINDOW_MARGIN_DAYS = 30;
const BOOKED_CLASS_WINDOW_MAX_DAYS = 180;
async function classWindowDays(admin: SupabaseClient, activityId: string, days: number): Promise<number> {
  const { data } = await admin
    .from('bookings')
    .select('activity_sessions!inner(activity_id, starts_at)')
    .eq('activity_sessions.activity_id', activityId)
    .gt('activity_sessions.starts_at', new Date().toISOString())
    .in('status', ['pending', 'confirmed', 'waitlisted'])
    .limit(1000);
  let furthest = 0;
  for (const row of data ?? []) {
    const s = row.activity_sessions as unknown as { starts_at: string } | null;
    if (s) furthest = Math.max(furthest, new Date(s.starts_at).getTime());
  }
  if (!furthest) return days;
  const needed = Math.ceil((furthest - Date.now()) / 86400000) + BOOKED_CLASS_WINDOW_MARGIN_DAYS;
  return Math.min(BOOKED_CLASS_WINDOW_MAX_DAYS, Math.max(days, needed));
}

/** See lib/wix/sync.ts's syncWixActivityAvailability — identical logic
 *  (this *is* that function's port, the same way everything else in this
 *  file is; app/api/wix/slots/route.ts calls the Vercel original, this cron
 *  is the other caller). Fetches one activity's live Wix availability and
 *  upserts it into activity_sessions — branching on APPOINTMENT (time-slots
 *  API) vs CLASS/COURSE (calendar/sessions API). Throws on a genuine Wix/DB
 *  failure; the caller below (syncWixServicesToActivities) runs this across
 *  many activities via allSettled so one account's Wix hiccup can't sink
 *  the rest. */
async function syncWixActivityAvailability(
  admin: SupabaseClient,
  activity: WixSlotActivity,
  creds: WixCredentials,
  days: number
): Promise<WixAvailabilitySyncResult> {
  const isClass = activity.wix_service_type === 'CLASS' || activity.wix_service_type === 'COURSE';
  if (!isClass && !activity.wix_resource_id) {
    throw new Error('Activity is not linked to a bookable Wix service');
  }

  if (activity.wix_service_type === 'CLASS') days = await classWindowDays(admin, activity.id, days);
  const windowStart = new Date();
  const windowEnd = new Date(windowStart.getTime() + days * 24 * 60 * 60 * 1000);
  const staffIdsPromise: Promise<Set<string> | null> = fetchWixResources(creds)
    .then((rs) => new Set(rs.filter((r) => r.bookable).map((r) => r.id)))
    .catch(() => null);

  if (isClass) {
    const [sessionList, knownStaffIds] = await Promise.all([
      fetchWixClassSessionList(creds, activity.wix_service_id, days),
      staffIdsPromise,
    ]);
    const sessions = sessionList.sessions;
    const staffBySlotKey = new Map(
      sessions.map((s) => [
        encodeWixSlotKey({ kind: 'class', sessionId: s.id }),
        formatWixStaffNames(s.staff, knownStaffIds ?? undefined),
      ])
    );

    let courseSpan: { start: string; end: string } | null = null;
    if (activity.wix_service_type === 'COURSE') {
      try {
        const span = await fetchWixCourseSpan(creds, activity.wix_service_id);
        if (span.start && span.end) courseSpan = { start: span.start, end: span.end };
      } catch (e) {
        console.error('Wix course span lookup failed', e);
      }
    }

    if (sessions.length > 0) {
      const { error: syncError } = await admin.from('activity_sessions').upsert(
        sessions.map((s) => ({
          activity_id: activity.id,
          starts_at: s.start,
          ends_at: s.end,
          capacity: s.capacity,
          wix_remaining_capacity: s.remainingCapacity,
          wix_slot_key: encodeWixSlotKey({ kind: 'class', sessionId: s.id }),
          // Wix lists it as CONFIRMED, so it is running: brings back a session
          // an earlier pass cancelled if the vendor reinstated it. (Bookings
          // cancelled meanwhile stay cancelled; parents simply rebook.)
          status: 'scheduled' as const,
        })),
        { onConflict: 'activity_id,wix_slot_key' }
      );
      if (syncError) console.error('Wix class session sync failed', syncError);
      await importWixSessionStaff(admin, activity.id, staffBySlotKey);
    }
    await reconcileStaleWixSessions(
      admin,
      activity.id,
      new Set(sessions.map((s) => encodeWixSlotKey({ kind: 'class', sessionId: s.id }))),
      windowStart,
      windowEnd,
      { creds, listComplete: sessionList.complete }
    );
    return { kind: 'class', sessions, courseSpan };
  }

  // Wix-cancelled appointments are settled BEFORE the availability fetch, and on
  // their own: a Wix timeout or error fetching slots (the Promise.all below
  // throws) used to skip this entirely, so a booking the vendor had cancelled on
  // Wix stayed confirmed, with no email, until some later run got through. It
  // also has to run before the reschedule pass, so a cancelled booking is not
  // followed as a live one.
  try {
    await cancelWixCancelledAppointmentBookings(admin, activity.id, creds);
  } catch (e) {
    console.error('Wix appointment cancellation reconcile failed', activity.id, e);
  }
  const [rawSlots, confirmedBookings, knownStaffIds] = await Promise.all([
    fetchWixAvailability(creds, activity.wix_service_id, days, [activity.wix_resource_id]),
    fetchWixConfirmedAppointmentBookings(creds, activity.wix_service_id).catch(() => []),
    staffIdsPromise,
  ]);
  // Fix up any already-booked session Wix has since moved, before anything
  // below treats the new availability as the whole story.
  // Wix-cancelled appointments first, so they aren't then followed as live
  // bookings by the reschedule pass below.
  await reconcileRescheduledWixAppointments(admin, activity.id, confirmedBookings);
  const slots = selectNonOverlappingSlots(rawSlots);
  const bookedStarts = new Set(confirmedBookings.map((b) => new Date(b.start).toISOString()));
  // See lib/wix/client.ts's WixSlotKey doc comment: a vendor with more than
  // one business location offering the same appointment service returns one
  // time-slot entry per location for the same wall-clock start/end — `loc`
  // keeps those from colliding into one key (they used to, and the upsert
  // below failed outright — "ON CONFLICT DO UPDATE... cannot affect row a
  // second time" — silently killing the whole sync for that activity).
  const appointmentKey = (s: WixTimeSlot) =>
    encodeWixSlotKey({ kind: 'appointment', s: s.localStartDate, e: s.localEndDate, loc: s.location?.id ?? '' });
  const staffBySlotKey = new Map(
    slots.map((s) => [
      appointmentKey(s),
      formatWixStaffNames(wixSlotStaff(s), knownStaffIds ?? undefined),
    ])
  );

  if (slots.length > 0) {
    const { error: syncError } = await admin.from('activity_sessions').upsert(
      slots.map((s) => {
        const startsAtUtc = wixLocalToUtcIso(s.localStartDate, s.timeZone ?? 'UTC');
        const endsAtUtc = wixLocalToUtcIso(s.localEndDate, s.timeZone ?? 'UTC');
        return {
          activity_id: activity.id,
          starts_at: startsAtUtc,
          ends_at: endsAtUtc,
          capacity: 1,
          wix_remaining_capacity: bookedStarts.has(new Date(startsAtUtc).toISOString()) ? 0 : 1,
          wix_slot_key: appointmentKey(s),
        };
      }),
      { onConflict: 'activity_id,wix_slot_key' }
    );
    if (syncError) console.error('Wix appointment slot sync failed', syncError);
    await importWixSessionStaff(admin, activity.id, staffBySlotKey);
  }
  await reconcileStaleWixSessions(
    admin,
    activity.id,
    new Set(slots.map(appointmentKey)),
    windowStart,
    windowEnd
  );
  return { kind: 'appointment', slots };
}

const VENDOR_OVERRIDABLE_WIX_FIELDS = new Set(['price', 'title', 'description', 'image_urls']);

export async function syncWixServicesToActivities(
  admin: SupabaseClient,
  providerId: string,
  creds: WixCredentials,
  options?: { onlyServiceIds?: string[] }
): Promise<WixServiceSyncResult> {
  const [services, resources, wixLocations] = await Promise.all([
    fetchWixServices(creds),
    fetchWixResources(creds),
    fetchWixLocations(creds).catch(() => [] as WixLocation[]),
  ]);
  const bookableResources = resources.filter((r) => r.bookable);
  const resourceForService = (service: WixService) =>
    bookableResources.find((r) => service.staffMemberIds?.includes(r.id)) ?? bookableResources[0];
  const wixLocationsById = new Map(wixLocations.map((l) => [l.id, l]));
  const locationCache = new Map<string, string | null>();

  const { data: category } = await admin
    .from('activity_categories')
    .select('id')
    .order('sort_order')
    .limit(1)
    .single();

  const result: WixServiceSyncResult = { created: 0, updated: 0, skipped: [], removed: 0, revived: 0 };
  // Every APPOINTMENT/CLASS/COURSE this run touches — see the availability
  // pass after the loop below for why this exists (lib/wix/sync.ts's own
  // copy of the same comment has the full story).
  const activitiesForAvailabilitySync: WixSlotActivity[] = [];

  // The scheduled caller always passes nothing here — see the module doc.
  const explicitIds = options?.onlyServiceIds ? new Set(options.onlyServiceIds) : null;

  const { data: linkedRows } = await admin
    .from('activities')
    .select('id, wix_service_id, wix_missing_since, wix_locked_fields')
    .eq('provider_id', providerId)
    .not('wix_service_id', 'is', null);
  const linkedByServiceId = new Map(
    (linkedRows ?? []).map((r: any) => [r.wix_service_id as string, r])
  );

  for (const service of services) {
    const existing = linkedByServiceId.get(service.id) ?? null;
    const mayCreate = !!explicitIds && explicitIds.has(service.id);
    if (!existing && !mayCreate) continue;

    const type =
      service.type === 'APPOINTMENT' || service.type === 'CLASS' || service.type === 'COURSE'
        ? service.type
        : null;
    if (!type) {
      result.skipped.push({ name: service.name, reason: `Unsupported Wix service type "${service.type}"` });
      continue;
    }
    const resource = resourceForService(service);
    if (type === 'APPOINTMENT' && !resource) {
      result.skipped.push({ name: service.name, reason: 'No bookable staff/resource found on the Wix account' });
      continue;
    }

    const { locationId, address, postalCode } = await resolveWixServiceLocation(
      admin, providerId, service, wixLocationsById, locationCache
    );
    const price = wixServicePrice(service);
    const capacity = wixServiceCapacity(service);
    const imageUrl = wixServiceImageUrl(service);
    const wixDescription = service.description?.trim() || null;

    if (existing) {
      const patch: Record<string, unknown> = {
        title: service.name,
        wix_service_type: type,
        wix_resource_id: type === 'APPOINTMENT' ? resource!.id : null,
        location_id: locationId,
        address,
        postal_code: postalCode,
        ...(price != null ? { price } : {}),
        ...(capacity != null ? { default_capacity: capacity } : {}),
        ...(imageUrl ? { image_urls: [imageUrl] } : {}),
        ...(wixDescription ? { description: wixDescription } : {}),
        wix_missing_since: null,
      };
      for (const field of existing.wix_locked_fields ?? []) {
        if (VENDOR_OVERRIDABLE_WIX_FIELDS.has(field)) {
          delete patch[field];
        }
      }
      patch.wix_price = price;
      await admin
        .from('activities')
        .update(patch)
        .eq('id', existing.id);
      if (existing.wix_missing_since) result.revived++;
      result.updated++;
      activitiesForAvailabilitySync.push({
        id: existing.id,
        wix_service_id: service.id,
        wix_resource_id: type === 'APPOINTMENT' ? resource!.id : null,
        wix_service_type: type,
      });
      continue;
    }

    if (!category) {
      result.skipped.push({ name: service.name, reason: 'No activity category exists to assign yet' });
      continue;
    }

    const slug = `${slugify(service.name)}-${service.id.slice(0, 6)}`;
    const description =
      wixDescription ||
      'Imported from Wix. Finish this listing — category, age range and description — then publish it when ready.';
    const { data: inserted, error } = await admin
      .from('activities')
      .insert({
        slug,
        title: service.name,
        description,
        category_id: category.id,
        provider_id: providerId,
        is_published: false,
        wix_service_id: service.id,
        wix_service_type: type,
        wix_resource_id: type === 'APPOINTMENT' ? resource!.id : null,
        location_id: locationId,
        address,
        postal_code: postalCode,
        price,
        wix_price: price,
        default_capacity: capacity,
        image_urls: imageUrl ? [imageUrl] : [],
      })
      .select('id')
      .single();
    if (error || !inserted) {
      result.skipped.push({ name: service.name, reason: error?.message ?? 'insert returned no row' });
      continue;
    }
    result.created++;
    activitiesForAvailabilitySync.push({
      id: inserted.id,
      wix_service_id: service.id,
      wix_resource_id: type === 'APPOINTMENT' ? resource!.id : null,
      wix_service_type: type,
    });
  }

  // Every touched APPOINTMENT/CLASS/COURSE gets its near-term availability
  // pulled and materialized into activity_sessions right here — see
  // lib/wix/sync.ts's identical addition for the full reasoning: this used
  // to be the one thing this cron never did, so a Wix-linked activity's
  // actual date/time/duration stayed blank until some parent happened to
  // open its detail page. Concurrent across activities (allSettled) since
  // each is an independent Wix fetch with no shared state.
  const availabilitySettled = await Promise.allSettled(
    activitiesForAvailabilitySync.map((a) =>
      syncWixActivityAvailability(admin, a, creds, a.wix_service_type === 'COURSE' ? 60 : 30)
    )
  );
  availabilitySettled.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error('Wix availability sync failed for activity', activitiesForAvailabilitySync[i].id, r.reason);
    }
  });

  const fetchedServiceIds = new Set(services.map((s) => s.id));
  const { data: linked } = await admin
    .from('activities')
    .select('id, wix_service_id')
    .eq('provider_id', providerId)
    .not('wix_service_id', 'is', null)
    .is('wix_missing_since', null);
  for (const act of linked ?? []) {
    if (act.wix_service_id && !fetchedServiceIds.has(act.wix_service_id)) {
      await admin
        .from('activities')
        .update({ wix_missing_since: new Date().toISOString(), is_published: false })
        .eq('id', act.id);
      result.removed++;
    }
  }

  return result;
}
