import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  encodeWixSlotKey,
  getProviderWixCredentials,
  wixLocalToUtcIso,
} from '@/lib/wix/client';
import { syncWixActivityAvailability } from '@/lib/wix/sync';

/**
 * Live Wix availability for a Wix-linked activity. Used by the parent
 * booking picker and the vendor portal's Schedule calendar. Branches on
 * `wix_service_type`: APPOINTMENT services use the time-slots API (1 spot
 * each); CLASS/COURSE services use the calendar/sessions API (real
 * capacity) — see syncWixActivityAvailability in lib/wix/sync.ts, which does
 * the actual fetch + upsert into activity_sessions. This route is now just
 * that function's HTTP face: resolve the activity, call it, shape the
 * response.
 *
 * The staff member taking each slot is imported onto the local session rows
 * as a side effect (inside syncWixActivityAvailability), but is deliberately
 * NOT part of this response: it is vendor-facing only — the Schedule
 * calendar and the Bookings roster read it back out of the database — and
 * this route is public and unauthenticated, so returning it would put every
 * instructor's name in front of anyone who can guess an activity id.
 *
 * Every slot Wix reports (booked or not) is also upserted into
 * activity_sessions as a side effect, keyed on (activity_id, wix_slot_key) —
 * so a local copy of Wix availability always exists in our DB once anyone
 * has fetched it, and the vendor's Schedule calendar can read it back
 * alongside ordinary site sessions without a second live Wix call. None of
 * that changes the JSON — `capacity` here stays the parent picker's "spots
 * left" number (id stays `wix:`-prefixed so booking still routes through
 * /api/wix/bookings).
 *
 * Query: ?activityId=<uuid>&days=<int, default 7>
 */
// Every Wix API call is bounded at 20s by wixFetch, and these routes make
// several of them back to back (resolve a slot, create the booking, confirm
// it). On the platform default (~10s) a slow-but-healthy Wix response gets
// the function killed mid-flight and the user sees a bare network error —
// for credentials/bookings that were perfectly fine. Same 60s ceiling the
// other Wix routes already set.
export const maxDuration = 60;

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

  // Wix occurrences the vendor has closed to new bookings from the Schedule
  // calendar (00091). The pause lives on the local activity_sessions row —
  // sync never overwrites it — and is keyed by wix_slot_key, so a paused
  // slot is simply dropped from what the parent picker is offered.
  const { data: pausedRows } = await admin
    .from('activity_sessions')
    .select('wix_slot_key')
    .eq('activity_id', activity.id)
    .eq('bookings_paused', true)
    .not('wix_slot_key', 'is', null);
  const pausedKeys = new Set((pausedRows ?? []).map((r) => r.wix_slot_key as string));

  try {
    // wix_service_id was already checked non-null above (the 404 branch).
    const result = await syncWixActivityAvailability(admin, { ...activity, wix_service_id: activity.wix_service_id! }, creds, days);

    if (result.kind === 'class') {
      return NextResponse.json(
        {
          slots: result.sessions
            .filter((s) => s.remainingCapacity > 0)
            .map((s) => ({
              id: `wix:${encodeWixSlotKey({ kind: 'class', sessionId: s.id })}`,
              starts_at: s.start,
              ends_at: s.end,
              capacity: s.remainingCapacity,
            }))
            .filter((slot) => !pausedKeys.has(slot.id.slice(4))),
          ...(result.courseSpan ? { course: result.courseSpan } : {}),
        },
        // Concurrent viewers of the same activity's availability collapse to
        // one Wix round-trip (and one sync/reconcile pass) per window instead
        // of one each — a short, deliberate staleness trade for load. Booking
        // still re-verifies live availability at checkout, so this never
        // affects correctness, only how quickly a change shows up here.
        { headers: { 'Cache-Control': 'public, s-maxage=15, stale-while-revalidate=30' } }
      );
    }

    return NextResponse.json(
      {
        slots: result.slots
          .filter((s) => s.bookable)
          .map((s) => ({
            id: `wix:${encodeWixSlotKey({ kind: 'appointment', s: s.localStartDate, e: s.localEndDate })}`,
            starts_at: wixLocalToUtcIso(s.localStartDate, s.timeZone ?? 'UTC'),
            ends_at: wixLocalToUtcIso(s.localEndDate, s.timeZone ?? 'UTC'),
            capacity: 1,
          }))
          .filter((slot) => !pausedKeys.has(slot.id.slice(4))),
      },
      { headers: { 'Cache-Control': 'public, s-maxage=15, stale-while-revalidate=30' } }
    );
  } catch (e) {
    console.error('Wix availability fetch failed', e);
    return NextResponse.json({ error: 'Could not reach Wix' }, { status: 502 });
  }
}
