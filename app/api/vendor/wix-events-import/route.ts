import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireProviderRole } from '@/lib/vendor';
import { fetchWixEvents, getProviderWixCredentials } from '@/lib/wix/client';
import { syncProviderWixEvents, unlinkWixEventActivities } from '@/lib/wix/events-sync';

/**
 * "Save" on the Import specific events picker (Settings -> Integrate your
 * Business). `event_ids` is the vendor's *full* desired selection among
 * events the picker actually showed them — mirrors
 * /api/vendor/wix-services-import exactly, event-shaped.
 * Body: { provider_id, event_ids: string[] }
 */
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
      admin.from('activities').select('wix_event_id').eq('provider_id', providerId).not('wix_event_id', 'is', null),
      fetchWixEvents(creds),
    ]);
    const localIdToWixId = new Map((eventRows ?? []).map((r) => [r.id, r.wix_event_id]));
    const currentIds = new Set(
      (linkedActivities ?? []).map((a) => localIdToWixId.get(a.wix_event_id as string)).filter(Boolean) as string[]
    );
    const wixVisibleIds = new Set(wixEvents.map((e) => e.id));
    const selected = new Set(eventIds);

    // Same reasoning as wix-services-import: only an event still visible on
    // the currently-connected account gets treated as "left unchecked,
    // please unlink" — one the picker never showed goes to
    // syncProviderWixEvents's own reconciliation (wix_missing_since)
    // instead, since that's recoverable rather than a deliberate uncheck.
    const toRemove = [...currentIds].filter((id) => wixVisibleIds.has(id) && !selected.has(id));

    // Unlink attempt runs BEFORE the mirror sync below, not after — an event
    // with real bookings on it gets refused (see unlinkWixEventActivities)
    // and needs to stay in the sync's own onlyEventIds so it keeps getting
    // updated like any other still-listed activity, instead of silently
    // falling out of step because the vendor tried to uncheck it.
    const unlinkResult = toRemove.length
      ? await unlinkWixEventActivities(admin, providerId, toRemove)
      : { removed: 0, protectedEvents: [] };
    const effectiveEventIds = [...new Set([...eventIds, ...unlinkResult.protectedEvents.map((p) => p.wixEventId)])];

    const sync = await syncProviderWixEvents(admin, providerId, creds, { onlyEventIds: effectiveEventIds });

    return NextResponse.json({
      ok: true,
      sync: { ...sync, unlinked: unlinkResult.removed },
      protectedEvents: unlinkResult.protectedEvents,
    });
  } catch (e) {
    console.error('Wix selective event import failed', e);
    return NextResponse.json({ error: 'Could not reach Wix' }, { status: 502 });
  }
}
