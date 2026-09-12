import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireProviderRole } from '@/lib/vendor';
import { getProviderWixCredentials, fetchWixSessionBookings } from '@/lib/wix/client';

/**
 * Read-only fallback for the vendor Bookings page: a customer who booked
 * directly on the vendor's own Wix site (not through BabyBrain) has no row
 * in the local `bookings` table — nothing creates one for a native Wix
 * booking, so the roster looked empty even though Wix's own remaining
 * capacity showed real enrolments. Fetches Wix's own attendee list for the
 * session's service instead, purely for display — nothing here is written
 * locally.
 *
 * A COURSE enrolment is booked once for the whole run (see the anchor-row
 * comments in lib/wix/sync.ts), so every attendee returned belongs to every
 * occurrence alike — `isCourseWide` tells the caller not to filter by this
 * particular occurrence's time. A CLASS/APPOINTMENT booking is per-occurrence,
 * so those are filtered down to the ones starting at this session's own time.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const providerId = searchParams.get('providerId');
  const sessionId = searchParams.get('sessionId');
  if (!providerId) return NextResponse.json({ error: 'providerId required' }, { status: 400 });
  if (!sessionId) return NextResponse.json({ error: 'sessionId required' }, { status: 400 });

  const auth = await requireProviderRole(request, providerId, 'staff');
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const admin = createAdminClient();
  const { data: session } = await admin
    .from('activity_sessions')
    .select('id, starts_at, ends_at, activity_id')
    .eq('id', sessionId)
    .maybeSingle();
  if (!session) return NextResponse.json({ attendees: [], isCourseWide: false });

  const { data: activity } = await admin
    .from('activities')
    .select('provider_id, wix_service_id, wix_service_type')
    .eq('id', session.activity_id)
    .eq('provider_id', providerId)
    .maybeSingle();
  if (!activity?.wix_service_id) return NextResponse.json({ attendees: [], isCourseWide: false });

  const creds = await getProviderWixCredentials(admin, providerId);
  if (!creds) return NextResponse.json({ error: 'This business has not connected a Wix account' }, { status: 409 });

  try {
    const all = await fetchWixSessionBookings(creds, activity.wix_service_id);
    const isCourseWide = activity.wix_service_type === 'COURSE';
    // A CLASS/APPOINTMENT booking's startDate is the exact occurrence Wix
    // booked, stored as the same instant this session's own starts_at came
    // from (see /api/wix/slots) — a tolerance keeps this robust to
    // millisecond-level formatting differences rather than needing an exact
    // string match.
    const sessionStart = new Date(session.starts_at).getTime();
    const attendees = isCourseWide
      ? all
      : all.filter((b) => b.startDate && Math.abs(new Date(b.startDate).getTime() - sessionStart) < 60_000);

    return NextResponse.json({ attendees, isCourseWide });
  } catch (e) {
    console.error('Wix session bookings fetch failed', e);
    return NextResponse.json({ error: 'Could not reach Wix' }, { status: 502 });
  }
}
