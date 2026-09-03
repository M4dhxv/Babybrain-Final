import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireProviderRole } from '@/lib/vendor';
import { getProviderWixCredentials, fetchWixLocations } from '@/lib/wix/client';

/**
 * "Import" on the Settings -> Locations "Fetch from Wix" picker. Purely
 * additive, unlike the Wix service import picker — a location a vendor
 * later deselects isn't unlinked here, since activities may already point
 * at it via location_id; removing it is the existing manual delete action.
 * The first imported location becomes the primary branch only if the
 * provider has none yet, matching the manual "Add location" form's own rule.
 * Body: { provider_id, location_ids: string[] }
 */
// Every Wix API call is bounded at 20s by wixFetch, and these routes make
// several of them back to back (resolve a slot, create the booking, confirm
// it). On the platform default (~10s) a slow-but-healthy Wix response gets
// the function killed mid-flight and the user sees a bare network error —
// for credentials/bookings that were perfectly fine. Same 60s ceiling the
// other Wix routes already set.
export const maxDuration = 60;

export async function POST(request: Request) {
  const { provider_id: providerId, location_ids: locationIds } = (await request.json().catch(() => ({}))) as {
    provider_id?: string;
    location_ids?: string[];
  };
  if (!providerId) return NextResponse.json({ error: 'provider_id required' }, { status: 400 });
  if (!Array.isArray(locationIds) || locationIds.length === 0) {
    return NextResponse.json({ error: 'location_ids must be a non-empty array' }, { status: 400 });
  }

  const auth = await requireProviderRole(request, providerId, 'manager');
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const admin = createAdminClient();
  const creds = await getProviderWixCredentials(admin, providerId);
  if (!creds) return NextResponse.json({ error: 'This business has not connected a Wix account' }, { status: 409 });

  try {
    const [wixLocations, { data: existingRows }] = await Promise.all([
      fetchWixLocations(creds),
      admin.from('provider_locations').select('wix_location_id').eq('provider_id', providerId),
    ]);

    const alreadyImported = new Set(
      (existingRows ?? []).map((r) => r.wix_location_id).filter((id): id is string => !!id)
    );
    const hasAnyLocation = (existingRows ?? []).length > 0;
    const byId = new Map(wixLocations.map((l) => [l.id, l]));

    const toInsert = locationIds
      .filter((id) => !alreadyImported.has(id) && byId.has(id))
      .map((id) => byId.get(id)!)
      .map((l, i) => ({
        provider_id: providerId,
        name: l.name,
        address: l.address,
        postal_code: l.postalCode,
        wix_location_id: l.id,
        is_primary: !hasAnyLocation && i === 0,
      }));

    if (toInsert.length === 0) {
      return NextResponse.json({ ok: true, imported: 0 });
    }

    const { error } = await admin.from('provider_locations').insert(toInsert);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ ok: true, imported: toInsert.length });
  } catch (e) {
    console.error('Wix location import failed', e);
    return NextResponse.json({ error: 'Could not reach Wix' }, { status: 502 });
  }
}
