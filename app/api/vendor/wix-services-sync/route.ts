import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireProviderRole } from '@/lib/vendor';
import { getProviderWixCredentials } from '@/lib/wix/client';
import { syncWixServicesToActivities } from '@/lib/wix/sync';

/**
 * "Sync services" on Settings -> Integrate your Business. Re-runs the same
 * service->activity sync that happens automatically when a Wix account is
 * first connected — for picking up services added on Wix since then.
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
    const sync = await syncWixServicesToActivities(admin, providerId, creds);
    return NextResponse.json({ ok: true, sync });
  } catch (e) {
    console.error('Wix service sync failed', e);
    return NextResponse.json({ error: 'Could not reach Wix' }, { status: 502 });
  }
}
