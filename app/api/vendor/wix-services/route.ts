import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireProviderRole } from '@/lib/vendor';
import { getProviderWixCredentials, fetchWixServices, fetchWixResources } from '@/lib/wix/client';

/**
 * Lists the services on a vendor's connected Wix account, each flagged with
 * whether it's importable and whether it's already an activity here — feeds
 * the "Import specific activities" picker on Settings -> Integrate your
 * Business (POST /api/vendor/wix-services-import saves the selection).
 */
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
    const [services, resources, { data: imported }] = await Promise.all([
      fetchWixServices(creds),
      fetchWixResources(creds),
      admin
        .from('activities')
        .select('wix_service_id')
        .eq('provider_id', providerId)
        .not('wix_service_id', 'is', null),
    ]);

    const hasBookableResource = resources.some((r) => r.bookable);
    const importedIds = new Set((imported ?? []).map((a) => a.wix_service_id as string));

    const list = services.map((s) => {
      const type = s.type === 'APPOINTMENT' || s.type === 'CLASS' || s.type === 'COURSE' ? s.type : null;
      const reason = !type
        ? `Unsupported Wix service type "${s.type}"`
        : type === 'APPOINTMENT' && !hasBookableResource
          ? 'No bookable staff/resource found on the Wix account'
          : null;
      return {
        id: s.id,
        name: s.name,
        type: s.type,
        importable: reason === null,
        reason,
        alreadyImported: importedIds.has(s.id),
      };
    });

    return NextResponse.json({ services: list });
  } catch (e) {
    console.error('Wix service list failed', e);
    return NextResponse.json({ error: 'Could not reach Wix' }, { status: 502 });
  }
}
