import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireProviderRole } from '@/lib/vendor';
import { getProviderWixCredentials, fetchWixEvents, WixApiError } from '@/lib/wix/client';
import { groupEventsForPicker } from '@/lib/wix/events-series';

/**
 * Lists the events on a vendor's connected Wix account, each flagged with
 * whether it's already an activity here — feeds the "Import specific
 * events" picker on Settings -> Integrate your Business (POST
 * /api/vendor/wix-events-import saves the selection). Mirrors
 * /api/vendor/wix-services for Bookings.
 */
// Wix syncs make many sequential Wix API + DB round-trips; the default
// ~10s function budget is not enough on a first import and the client just
// sees "Failed to fetch" when the platform kills it mid-flight.
export const maxDuration = 60;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const providerId = searchParams.get('providerId');
  if (!providerId) return NextResponse.json({ error: 'providerId required' }, { status: 400 });

  const auth = await requireProviderRole(request, providerId, 'manager');
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const admin = createAdminClient();
  const creds = await getProviderWixCredentials(admin, providerId);
  if (!creds) return NextResponse.json({ error: 'This business has not connected a Wix account' }, { status: 409 });

  try {
    const [events, { data: eventRows }, { data: linkedActivities }] = await Promise.all([
      // Matches syncProviderWixEvents's own DAYS_AHEAD window (365) — the
      // picker should never show (or silently miss) an event the "Sync Wix
      // Events" button wouldn't have picked up.
      fetchWixEvents(creds, 365),
      admin.from('wix_events').select('id, wix_event_id').eq('provider_id', providerId),
      admin
        .from('activities')
        .select('wix_event_id, wix_series_id')
        .eq('provider_id', providerId)
        .is('wix_removed_at', null)
        .or('wix_event_id.not.is.null,wix_series_id.not.is.null'),
    ]);

    // activities.wix_event_id is the LOCAL wix_events.id, not Wix's own
    // event id — resolved back to the id this list is keyed on via
    // eventRows rather than a PostgREST relationship embed, to not depend
    // on the schema cache having that FK indexed.
    const localIdToWixId = new Map((eventRows ?? []).map((r) => [r.id, r.wix_event_id]));
    const importedWixIds = new Set(
      (linkedActivities ?? []).map((a) => localIdToWixId.get(a.wix_event_id as string)).filter(Boolean)
    );
    const importedSeries = new Set((linkedActivities ?? []).map((a) => a.wix_series_id).filter(Boolean));

    // A recurring event is a series of separate Wix events; the vendor sees (and imports) it
    // as ONE row, which becomes one activity with a session per date.
    const groups = groupEventsForPicker(events);
    const list = groups.map((g) => ({
      id: g.id,
      name: g.name,
      type: 'EVENT',
      startDate: g.startDate,
      occurrences: g.occurrences,
      // A multi-day event (split into one session per day) is imported under a key of its own: `md:<event id>`.
      alreadyImported: g.seriesId
        ? importedSeries.has(g.seriesId) || g.memberIds.some((id) => importedWixIds.has(id))
        : importedWixIds.has(g.id) || importedSeries.has(`md:${g.id}`),
    }));

    return NextResponse.json({ events: list, eventsAppNotInstalled: false });
  } catch (e) {
    if (e instanceof WixApiError && (e.status === 428 || e.status === 403 || e.status === 404)) {
      return NextResponse.json({ events: [], eventsAppNotInstalled: true });
    }
    console.error('Wix event list failed', e);
    return NextResponse.json({ error: 'Could not reach Wix' }, { status: 502 });
  }
}
