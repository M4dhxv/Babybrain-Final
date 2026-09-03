import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireProviderRole } from '@/lib/vendor';
import { fetchWixServices, getProviderWixCredentials } from '@/lib/wix/client';
import { syncWixServicesToActivities, unlinkWixActivities } from '@/lib/wix/sync';

/**
 * "Save" on the Import specific activities picker (Settings -> Integrate
 * your Business). `service_ids` is the vendor's *full* desired selection
 * among services the picker actually showed them, not just additions — a
 * service already imported but left unchecked gets unlinked (see
 * unlinkWixActivities), one that's newly checked gets imported, matching
 * the picker's checkbox semantics. Distinct from the "Sync services" button
 * (POST /api/vendor/wix-services-sync), which always syncs every service on
 * the account.
 *
 * Only a service still on the *currently connected* account gets treated as
 * "left unchecked, please unlink" — `service_ids` can only ever list
 * services the vendor could see when they saved, so a locally-linked
 * service that isn't even part of this account's list (the vendor swapped
 * in an API key for a different site since it was linked) was previously
 * indistinguishable from a deliberate uncheck, and got the same permanent
 * unlinkWixActivities treatment. That's now syncWixServicesToActivities's
 * job instead (wix_missing_since) — recoverable by reconnecting the right
 * account, rather than a silent, permanent detach.
 * Body: { provider_id, service_ids: string[] }
 */
// Wix syncs make many sequential Wix API + DB round-trips; the default
// ~10s function budget is not enough on a first import and the client just
// sees "Failed to fetch" when the platform kills it mid-flight.
export const maxDuration = 60;

export async function POST(request: Request) {
  const { provider_id: providerId, service_ids: serviceIds } = (await request.json().catch(() => ({}))) as {
    provider_id?: string;
    service_ids?: string[];
  };
  if (!providerId) return NextResponse.json({ error: 'provider_id required' }, { status: 400 });
  if (!Array.isArray(serviceIds)) {
    return NextResponse.json({ error: 'service_ids must be an array' }, { status: 400 });
  }

  const auth = await requireProviderRole(request, providerId, 'manager');
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const admin = createAdminClient();
  const creds = await getProviderWixCredentials(admin, providerId);
  if (!creds) return NextResponse.json({ error: 'This business has not connected a Wix account' }, { status: 409 });

  try {
    const [{ data: existing }, wixServices] = await Promise.all([
      admin.from('activities').select('wix_service_id').eq('provider_id', providerId).not('wix_service_id', 'is', null),
      fetchWixServices(creds),
    ]);
    const currentIds = new Set((existing ?? []).map((a) => a.wix_service_id as string));
    const wixVisibleIds = new Set(wixServices.map((s) => s.id));
    const selected = new Set(serviceIds);

    const toAdd = serviceIds.filter((id) => !currentIds.has(id));
    // A locally-linked service that isn't even in wixVisibleIds was never a
    // real option in this save (the picker can only ever show/select
    // services on the connected account) — leave it for
    // syncWixServicesToActivities's reconciliation to flag as missing
    // instead of treating "vendor never saw this box" as "vendor unchecked
    // this box".
    const toRemove = [...currentIds].filter((id) => wixVisibleIds.has(id) && !selected.has(id));

    // The unlink runs BEFORE the sync, not after — a service with real
    // bookings on it gets refused (see unlinkWixActivities) and has to stay
    // in the sync's own onlyServiceIds so it keeps being kept in step like
    // any other still-listed activity, rather than quietly falling out of
    // date because the vendor tried to uncheck it. Same order and reasoning
    // as wix-events-import.
    const unlinkResult = toRemove.length
      ? await unlinkWixActivities(admin, providerId, toRemove)
      : { removed: 0, protectedServices: [] };

    // Always run the full sync, not just when toAdd is non-empty — its
    // reconciliation pass (wix_missing_since) is what correctly handles
    // every locally-linked service this save's selection couldn't include,
    // and that needs to run on every save, not only ones adding something.
    const sync = await syncWixServicesToActivities(admin, providerId, creds, {
      onlyServiceIds: [...new Set([...toAdd, ...unlinkResult.protectedServices.map((p) => p.wixServiceId)])],
    });

    // Distinct from `sync.removed` (services the reconciliation pass inside
    // syncWixServicesToActivities found missing from the account entirely) —
    // `unlinked` is a vendor's own deliberate uncheck in this picker.
    return NextResponse.json({
      ok: true,
      sync: { ...sync, unlinked: unlinkResult.removed },
      protectedServices: unlinkResult.protectedServices,
    });
  } catch (e) {
    console.error('Wix selective import failed', e);
    return NextResponse.json({ error: 'Could not reach Wix' }, { status: 502 });
  }
}
