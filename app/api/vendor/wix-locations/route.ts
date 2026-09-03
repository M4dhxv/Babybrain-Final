import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireProviderRole } from '@/lib/vendor';
import { getProviderWixCredentials, fetchWixLocations } from '@/lib/wix/client';

/**
 * Lists the business locations on a vendor's connected Wix account, each
 * flagged with whether it's already been imported as a provider_locations
 * row here — feeds the "Fetch from Wix" picker on Settings -> Locations
 * (POST /api/vendor/wix-locations-import saves the selection).
 */
// Every Wix API call is bounded at 20s by wixFetch, and these routes make
// several of them back to back (resolve a slot, create the booking, confirm
// it). On the platform default (~10s) a slow-but-healthy Wix response gets
// the function killed mid-flight and the user sees a bare network error —
// for credentials/bookings that were perfectly fine. Same 60s ceiling the
// other Wix routes already set.
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
    const [locations, { data: imported }] = await Promise.all([
      fetchWixLocations(creds),
      admin
        .from('provider_locations')
        .select('wix_location_id')
        .eq('provider_id', providerId)
        .not('wix_location_id', 'is', null),
    ]);

    const importedIds = new Set((imported ?? []).map((l) => l.wix_location_id as string));
    const list = locations.map((l) => ({ ...l, alreadyImported: importedIds.has(l.id) }));

    return NextResponse.json({ locations: list });
  } catch (e) {
    console.error('Wix location list failed', e);
    return NextResponse.json({ error: 'Could not reach Wix' }, { status: 502 });
  }
}
