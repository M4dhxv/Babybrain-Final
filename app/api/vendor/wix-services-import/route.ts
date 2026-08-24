import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireProviderRole } from '@/lib/vendor';
import { getProviderWixCredentials } from '@/lib/wix/client';
import { syncWixServicesToActivities, unlinkWixActivities } from '@/lib/wix/sync';

/**
 * "Save" on the Import specific activities picker (Settings -> Integrate
 * your Business). `service_ids` is the vendor's *full* desired selection,
 * not just additions — a service already imported but missing from this
 * list gets unlinked (see unlinkWixActivities), one that's newly present
 * gets imported, matching the picker's checkbox semantics. Distinct from
 * the "Sync services" button (POST /api/vendor/wix-services-sync), which
 * always syncs every service on the account.
 * Body: { provider_id, service_ids: string[] }
 */
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
    const { data: existing } = await admin
      .from('activities')
      .select('wix_service_id')
      .eq('provider_id', providerId)
      .not('wix_service_id', 'is', null);
    const currentIds = new Set((existing ?? []).map((a) => a.wix_service_id as string));
    const selected = new Set(serviceIds);

    const toAdd = serviceIds.filter((id) => !currentIds.has(id));
    const toRemove = [...currentIds].filter((id) => !selected.has(id));

    const sync = toAdd.length
      ? await syncWixServicesToActivities(admin, providerId, creds, { onlyServiceIds: toAdd })
      : { created: 0, updated: 0, skipped: [] };
    const removed = toRemove.length ? await unlinkWixActivities(admin, providerId, toRemove) : 0;

    return NextResponse.json({ ok: true, sync: { ...sync, removed } });
  } catch (e) {
    console.error('Wix selective import failed', e);
    return NextResponse.json({ error: 'Could not reach Wix' }, { status: 502 });
  }
}
