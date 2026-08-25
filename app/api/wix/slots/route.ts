import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  fetchWixAvailability,
  fetchWixClassSessions,
  fetchWixConfirmedAppointmentBookings,
  encodeWixSlotKey,
  getProviderWixCredentials,
  wixLocalToUtcIso,
} from '@/lib/wix/client';

/**
 * Removes local `activity_sessions` rows for slots this same fetch's window
 * covered but Wix no longer offers — the vendor edited their weekly hours,
 * changed a session's duration, swapped staff, etc., and the old candidate
 * times (upserted from an earlier fetch, keyed by their own now-defunct
 * `wix_slot_key`) otherwise linger forever, since upsert only ever adds or
 * updates, never removes. Scoped to `[windowStart, windowEnd)` — the exact
 * range this fetch actually queried — so a session further out that a
 * narrower `days` window simply didn't ask about is never touched. Only
 * deletes a session with no real booking against it (local or Wix-side,
 * matching unlinkWixActivities's deleteUnbookedSessions in lib/wix/sync.ts) —
 * a booked slot disappearing from live availability is exactly what a
 * confirmed booking should do, not grounds for deleting the booking's own
 * session.
 */
async function reconcileStaleWixSessions(
  admin: SupabaseClient<Database>,
  activityId: string,
  currentKeys: Set<string>,
  windowStart: Date,
  windowEnd: Date
): Promise<void> {
  const { data: existing } = await admin
    .from('activity_sessions')
    .select('id, wix_slot_key, wix_remaining_capacity, capacity')
    .eq('activity_id', activityId)
    .not('wix_slot_key', 'is', null)
    .gte('starts_at', windowStart.toISOString())
    .lt('starts_at', windowEnd.toISOString());
  const stale = (existing ?? []).filter((s) => !currentKeys.has(s.wix_slot_key!));
  if (stale.length === 0) return;

  const { data: bookings } = await admin
    .from('bookings')
    .select('session_id, status')
    .in('session_id', stale.map((s) => s.id));
  const bookedSessionIds = new Set(
    (bookings ?? []).filter((b) => b.status !== 'cancelled').map((b) => b.session_id)
  );

  for (const s of stale) {
    // Wix's own remaining-capacity snapshot from the last time this slot was
    // fetched is the other signal a real seat is filled (a class booked
    // directly on Wix's own site, not just through BabyBrain).
    const bookedOnWix = s.wix_remaining_capacity != null && s.capacity != null && s.wix_remaining_capacity < s.capacity;
    if (bookedSessionIds.has(s.id) || bookedOnWix) continue;
    await admin.from('activity_sessions').delete().eq('id', s.id);
  }
}

/**
 * Live Wix availability for a Wix-linked activity. Used by the parent
 * booking picker and the vendor portal's Schedule calendar. Branches on
 * `wix_service_type`: APPOINTMENT services use the time-slots API (1 spot
 * each); CLASS/COURSE services use the calendar/sessions API (real
 * capacity) — see lib/wix/client.ts.
 *
 * Every slot Wix reports (booked or not) is also upserted into
 * activity_sessions as a side effect, keyed on (activity_id, wix_slot_key) —
 * so a local copy of Wix availability always exists in our DB once anyone
 * has fetched it, and the vendor's Schedule calendar can read it back
 * alongside ordinary site sessions without a second live Wix call. The JSON
 * response itself is unchanged by this — `capacity` here stays the parent
 * picker's "spots left" number (id stays `wix:`-prefixed so booking still
 * routes through /api/wix/bookings).
 *
 * Query: ?activityId=<uuid>&days=<int, default 7>
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const activityId = params.get('activityId');
  let days = Math.min(Math.max(Number(params.get('days')) || 7, 1), 60);
  if (!activityId) {
    return NextResponse.json({ error: 'activityId required' }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: activity } = await admin
    .from('activities')
    .select('id, provider_id, wix_service_id, wix_resource_id, wix_service_type')
    .eq('id', activityId)
    .maybeSingle();

  if (!activity?.wix_service_id || !activity.provider_id) {
    return NextResponse.json({ error: 'Activity is not linked to a Wix service' }, { status: 404 });
  }
  // A COURSE (e.g. a holiday camp) is typically scheduled months ahead and
  // gets viewed far less often than an APPOINTMENT/CLASS — every other
  // caller here passes whatever near-term window is currently on screen
  // (a week or a month), which routinely misses a course's one occurrence
  // sitting 40-50 days out until someone happens to page the calendar that
  // far forward. Always use the app's existing 60-day ceiling for courses
  // instead, regardless of what the caller asked for.
  if (activity.wix_service_type === 'COURSE') days = 60;
  const isClass = activity.wix_service_type === 'CLASS' || activity.wix_service_type === 'COURSE';
  if (!isClass && !activity.wix_resource_id) {
    return NextResponse.json({ error: 'Activity is not linked to a Wix service' }, { status: 404 });
  }

  const creds = await getProviderWixCredentials(admin, activity.provider_id);
  if (!creds) {
    return NextResponse.json({ error: 'This business has not connected a Wix account' }, { status: 409 });
  }

  const windowStart = new Date();
  const windowEnd = new Date(windowStart.getTime() + days * 24 * 60 * 60 * 1000);

  try {
    if (isClass) {
      const sessions = await fetchWixClassSessions(creds, activity.wix_service_id, days);

      if (sessions.length > 0) {
        const { error: syncError } = await admin.from('activity_sessions').upsert(
          sessions.map((s) => ({
            activity_id: activity.id,
            starts_at: s.start,
            ends_at: s.end,
            capacity: s.capacity,
            wix_remaining_capacity: s.remainingCapacity,
            wix_slot_key: encodeWixSlotKey({ kind: 'class', sessionId: s.id }),
          })),
          { onConflict: 'activity_id,wix_slot_key' }
        );
        if (syncError) console.error('Wix class session sync failed', syncError);
      }
      await reconcileStaleWixSessions(
        admin,
        activity.id,
        new Set(sessions.map((s) => encodeWixSlotKey({ kind: 'class', sessionId: s.id }))),
        windowStart,
        windowEnd
      );

      return NextResponse.json({
        slots: sessions
          .filter((s) => s.remainingCapacity > 0)
          .map((s) => ({
            id: `wix:${encodeWixSlotKey({ kind: 'class', sessionId: s.id })}`,
            starts_at: s.start,
            ends_at: s.end,
            capacity: s.remainingCapacity,
          })),
      });
    }

    const [slots, confirmedBookings] = await Promise.all([
      fetchWixAvailability(creds, activity.wix_service_id, days),
      // A slot's own `bookable` flag conflates "a customer holds this time"
      // with every other reason Wix won't offer it to someone new (e.g. the
      // service's minimum-notice booking policy blocking same-day slots) —
      // cross-checking against real confirmed bookings is what actually
      // tells the vendor Schedule page whether a slot is booked vs. simply
      // not offered right now. Never blocks the availability fetch above.
      fetchWixConfirmedAppointmentBookings(creds, activity.wix_service_id).catch(() => []),
    ]);
    // `b.start` (from the real bookings resource) is a genuine UTC
    // timestamp; comparing it against a slot means first converting that
    // slot's own site-local `localStartDate` the same way — see
    // wixLocalToUtcIso and the comment on fetchWixAvailability for why that
    // conversion can't be skipped just because there's no offset suffix.
    const bookedStarts = new Set(confirmedBookings.map((b) => new Date(b.start).toISOString()));

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
            // The slot key is Wix's own round-trip identifier — stays the raw
            // site-local strings Wix gave us, since re-fetching availability
            // and creating the actual booking both compare/send this exact
            // same untouched value back to Wix.
            wix_slot_key: encodeWixSlotKey({ kind: 'appointment', s: s.localStartDate, e: s.localEndDate }),
          };
        }),
        { onConflict: 'activity_id,wix_slot_key' }
      );
      if (syncError) console.error('Wix appointment slot sync failed', syncError);
    }
    await reconcileStaleWixSessions(
      admin,
      activity.id,
      new Set(slots.map((s) => encodeWixSlotKey({ kind: 'appointment', s: s.localStartDate, e: s.localEndDate }))),
      windowStart,
      windowEnd
    );

    return NextResponse.json({
      slots: slots
        .filter((s) => s.bookable)
        .map((s) => ({
          id: `wix:${encodeWixSlotKey({ kind: 'appointment', s: s.localStartDate, e: s.localEndDate })}`,
          starts_at: wixLocalToUtcIso(s.localStartDate, s.timeZone ?? 'UTC'),
          ends_at: wixLocalToUtcIso(s.localEndDate, s.timeZone ?? 'UTC'),
          capacity: 1,
        })),
    });
  } catch (e) {
    console.error('Wix availability fetch failed', e);
    return NextResponse.json({ error: 'Could not reach Wix' }, { status: 502 });
  }
}
