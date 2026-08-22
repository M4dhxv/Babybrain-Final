import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireProviderRole } from '@/lib/vendor';
import { fetchWixBusyRanges, getProviderWixCredentials } from '@/lib/wix/client';

/**
 * Every time range the vendor is already committed to on Wix, across all
 * their services — used by the vendor portal to block an independent
 * (non-Wix) slot that would clash with something already on Wix. Reveals
 * what's on a business's private Wix calendar, so it's member-gated like
 * any other vendor-scoped route.
 * Query: ?providerId=<uuid>
 */
export async function GET(request: Request) {
  const providerId = new URL(request.url).searchParams.get('providerId');
  if (!providerId) {
    return NextResponse.json({ error: 'providerId required' }, { status: 400 });
  }

  const auth = await requireProviderRole(request, providerId, 'staff');
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const admin = createAdminClient();
  const creds = await getProviderWixCredentials(admin, providerId);
  if (!creds) {
    return NextResponse.json({ error: 'This business has not connected a Wix account' }, { status: 409 });
  }

  try {
    const ranges = await fetchWixBusyRanges(creds);
    return NextResponse.json({ ranges });
  } catch (e) {
    console.error('Wix busy-ranges fetch failed', e);
    return NextResponse.json({ error: 'Could not reach Wix' }, { status: 502 });
  }
}
