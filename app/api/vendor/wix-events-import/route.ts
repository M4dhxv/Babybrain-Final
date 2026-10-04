import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireProviderRole } from '@/lib/vendor';
import { fetchWixEvents, getProviderWixCredentials } from '@/lib/wix/client';
import { refreshWixEventHealth } from '@/lib/wix/events-reconcile';
import { groupEventsForPicker, representativeEventIds, seriesPickerId, unlinkWixSeries } from '@/lib/wix/events-series';
import { syncProviderWixEvents, unlinkWixEventActivities } from '@/lib/wix/events-sync';

/**
 * "Save" on the Import specific events picker (Settings -> Integrate your
 * Business). `event_ids` is the vendor's *full* desired selection among
 * events the picker actually showed them — mirrors
 * /api/vendor/wix-services-import exactly, event-shaped.
 * Body: { provider_id, event_ids: string[] }
 */
// Wix syncs make many sequential Wix API + DB round-trips; the default
// ~10s function budget is not enough on a first import and the client just
// sees "Failed to fetch" when the platform kills it mid-flight.
export const maxDuration = 60;

export async function POST(request: Request) {
  const { provider_id: providerId, event_ids: eventIds } = (await request.json().catch(() => ({}))) as {
    provider_id?: string;
    event_ids?: string[];
  };
  if (!providerId) return NextResponse.json({ error: 'provider_id required' }, { status: 400 });
  if (!Array.isArray(eventIds)) {
    return NextResponse.json({ error: 'event_ids must be an array' }, { status: 400 });
  }

  const auth = await requireProviderRole(request, providerId, 'manager');
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const admin = createAdminClient();
  const creds = await getProviderWixCredentials(admin, providerId);
  if (!creds) return NextResponse.json({ error: 'This business has not connected a Wix account' }, { status: 409 });

  try {
    const [{ data: eventRows }, { data: linkedActivities }, wixEvents] = await Promise.all([
      admin.from('wix_events').select('id, wix_event_id').eq('provider_id', providerId),
      admin
        .from('activities')
        .select('wix_event_id, wix_series_id')
        .eq('provider_id', providerId)
        .is('wix_removed_at', null)
        .or('wix_event_id.not.is.null,wix_series_id.not.is.null'),
      // Must match the picker's own window (GET /api/vendor/wix-events uses
      // 365, same as syncProviderWixEvents's DAYS_AHEAD) — this call feeds
      // wixVisibleIds below, which decides whether an unchecked event counts
      // as "still on the account, please unlink" at all. Left at the
      // fetchWixEvents default (90) here, any event 90-365 days out that the
      // vendor could see and uncheck in the picker was silently never in
      // wixVisibleIds, so toRemove never included it, unlinkWixEventActivities
      // was never called for it, and the uncheck appeared to do nothing —
      // the box came back ticked on every reload even though nothing was
      // protecting it.
      fetchWixEvents(creds, 365),
    ]);

    // The picker's ids: a plain Wix event id, or `series:<id>` for a recurring series (one
    // row, one activity, a session per date — see lib/wix/events-series).
    const groups = groupEventsForPicker(wixEvents);
    const pickerIdOfWixEvent = new Map<string, string>();
    for (const g of groups) for (const id of g.memberIds) pickerIdOfWixEvent.set(id, g.id);

    const localIdToWixId = new Map((eventRows ?? []).map((r) => [r.id, r.wix_event_id]));
    const currentIds = new Set<string>();
    // Multi-day events are split into days under a `md:<wix event id>` key; the picker still shows them as
    // the plain event, so map them back (or they'd look un-imported and be re-imported on every save).
    const importedMultiDay = new Set<string>();
    for (const a of linkedActivities ?? []) {
      if (a.wix_series_id?.startsWith('md:')) {
        importedMultiDay.add(a.wix_series_id.slice(3));
        currentIds.add(a.wix_series_id.slice(3));
        continue;
      }
      if (a.wix_series_id) currentIds.add(seriesPickerId(a.wix_series_id));
      const wixId = a.wix_event_id ? localIdToWixId.get(a.wix_event_id) : undefined;
      if (wixId) currentIds.add(pickerIdOfWixEvent.get(wixId) ?? wixId);
    }
    const wixVisibleIds = new Set(groups.map((g) => g.id));
    const selected = new Set(eventIds);

    // Same reasoning as wix-services-import: only an event still visible on
    // the currently-connected account gets treated as "left unchecked,
    // please unlink" — one the picker never showed goes to
    // syncProviderWixEvents's own reconciliation (wix_missing_since)
    // instead, since that's recoverable rather than a deliberate uncheck.
    const toRemove = [...currentIds].filter((id) => wixVisibleIds.has(id) && !selected.has(id));
    const removeSeries = toRemove.filter((id) => id.startsWith('series:')).map((id) => id.slice('series:'.length));
    const removeMultiDay = toRemove.filter((id) => importedMultiDay.has(id)).map((id) => `md:${id}`);
    const removeEvents = toRemove.filter((id) => !id.startsWith('series:') && !importedMultiDay.has(id));
    // A series may still have older per-date activities (not yet folded in): those are unlinked too.
    const seriesMemberWixIds = groups.filter((g) => g.seriesId && removeSeries.includes(g.seriesId)).flatMap((g) => g.memberIds);

    // Unlink attempt runs BEFORE the mirror sync below, not after — an event
    // with real bookings on it gets refused (see unlinkWixEventActivities)
    // and needs to stay in the sync's own onlyEventIds so it keeps getting
    // updated like any other still-listed activity, instead of silently
    // falling out of step because the vendor tried to uncheck it.
    const unlinkResult = removeEvents.length || seriesMemberWixIds.length
      ? await unlinkWixEventActivities(admin, providerId, [...removeEvents, ...seriesMemberWixIds])
      : { removed: 0, protectedEvents: [] };
    const seriesUnlink = removeSeries.length || removeMultiDay.length
      ? await unlinkWixSeries(admin, providerId, [...removeSeries, ...removeMultiDay])
      : { removed: 0, protectedSeries: [] };
    const protectedSeriesIds = new Set(seriesUnlink.protectedSeries.map((p) => p.seriesId));
    const protectedEvents = [
      ...unlinkResult.protectedEvents.filter((p) => !seriesMemberWixIds.includes(p.wixEventId)),
      ...seriesUnlink.protectedSeries.map((p) => ({
        wixEventId: p.seriesId.startsWith('md:') ? p.seriesId.slice(3) : seriesPickerId(p.seriesId),
        title: p.title,
      })),
    ];

    // What to actually mirror: standalone events as picked. A newly picked series is mirrored
    // through its earliest date; reconcile (right below) turns that into the series activity and
    // attaches the other dates. An already-imported series needs nothing mirrored.
    const stillSelected = [...new Set([...eventIds, ...protectedEvents.map((p) => p.wixEventId)])];
    const importedSeriesIds = new Set((linkedActivities ?? []).map((a) => a.wix_series_id).filter((x): x is string => !!x));
    const toMirror = stillSelected.filter(
      // An already-imported multi-day event needs nothing mirrored: mirroring it again would create a second
      // per-event activity next to its day-by-day one.
      (id) => !importedMultiDay.has(id) && (!id.startsWith('series:') || (!importedSeriesIds.has(id.slice('series:'.length)) && !protectedSeriesIds.has(id.slice('series:'.length))))
    );
    const effectiveEventIds = representativeEventIds(toMirror, wixEvents);

    const sync = await syncProviderWixEvents(admin, providerId, creds, { onlyEventIds: effectiveEventIds });
    // Fold the series together, and work out which dates can actually take a booking (and what
    // the vendor must fix in Wix first) now, not on the next background tick. Best effort.
    await refreshWixEventHealth(admin, providerId, creds).catch((e) => console.error('refreshWixEventHealth failed', e));

    return NextResponse.json({
      ok: true,
      sync: { ...sync, unlinked: unlinkResult.removed + seriesUnlink.removed },
      protectedEvents,
    });
  } catch (e) {
    console.error('Wix selective event import failed', e);
    return NextResponse.json({ error: 'Could not reach Wix' }, { status: 502 });
  }
}
