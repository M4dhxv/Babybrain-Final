import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchWixAvailability, fetchWixClassSessions, encodeWixSlotKey, getProviderWixCredentials } from '@/lib/wix/client';

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
  const days = Math.min(Math.max(Number(params.get('days')) || 7, 1), 60);
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
  const isClass = activity.wix_service_type === 'CLASS' || activity.wix_service_type === 'COURSE';
  if (!isClass && !activity.wix_resource_id) {
    return NextResponse.json({ error: 'Activity is not linked to a Wix service' }, { status: 404 });
  }

  const creds = await getProviderWixCredentials(admin, activity.provider_id);
  if (!creds) {
    return NextResponse.json({ error: 'This business has not connected a Wix account' }, { status: 409 });
  }

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

    const slots = await fetchWixAvailability(creds, activity.wix_service_id, days);

    if (slots.length > 0) {
      const { error: syncError } = await admin.from('activity_sessions').upsert(
        slots.map((s) => ({
          activity_id: activity.id,
          starts_at: s.localStartDate,
          ends_at: s.localEndDate,
          capacity: 1,
          wix_remaining_capacity: s.bookable ? 1 : 0,
          wix_slot_key: encodeWixSlotKey({ kind: 'appointment', s: s.localStartDate, e: s.localEndDate }),
        })),
        { onConflict: 'activity_id,wix_slot_key' }
      );
      if (syncError) console.error('Wix appointment slot sync failed', syncError);
    }

    return NextResponse.json({
      slots: slots
        .filter((s) => s.bookable)
        .map((s) => ({
          id: `wix:${encodeWixSlotKey({ kind: 'appointment', s: s.localStartDate, e: s.localEndDate })}`,
          starts_at: s.localStartDate,
          ends_at: s.localEndDate,
          capacity: 1,
        })),
    });
  } catch (e) {
    console.error('Wix availability fetch failed', e);
    return NextResponse.json({ error: 'Could not reach Wix' }, { status: 502 });
  }
}
