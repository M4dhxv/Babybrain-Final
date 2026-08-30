import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireProviderRole } from '@/lib/vendor';
import { getProviderWixCredentials } from '@/lib/wix/client';
import { syncProviderWixEvents } from '@/lib/wix/events-sync';

/**
 * "Sync events" — the Wix Events & Tickets equivalent of
 * app/api/vendor/wix-services-sync. A vendor connected for Bookings only
 * gets `eventsAppNotInstalled: true` back rather than an error (see
 * syncProviderWixEvents) since that app is a separate, optional install.
 * Body: { provider_id }
 */
export async function POST(request: Request) {
  const { provider_id: providerId } = (await request.json().catch(() => ({}))) as { provider_id?: string };
  if (!providerId) return NextResponse.json({ error: 'provider_id required' }, { status: 400 });

  const auth = await requireProviderRole(request, providerId, 'manager');
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const admin = createAdminClient();
  const creds = await getProviderWixCredentials(admin, providerId);
  if (!creds) return NextResponse.json({ error: 'This business has not connected a Wix account' }, { status: 409 });

  try {
    const sync = await syncProviderWixEvents(admin, providerId, creds);
    return NextResponse.json({ ok: true, sync });
  } catch (e) {
    console.error('Wix events sync failed', e);
    return NextResponse.json({ error: 'Could not reach Wix' }, { status: 502 });
  }
}
