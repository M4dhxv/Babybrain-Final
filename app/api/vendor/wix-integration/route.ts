import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireProviderRole } from '@/lib/vendor';
import { maskWixApiKey, fetchWixServices } from '@/lib/wix/client';
import { syncWixServicesToActivities } from '@/lib/wix/sync';

/**
 * Settings -> Integrate your Business. Lets a vendor connect their own Wix
 * account (API key + site ID) instead of relying on a shared global one.
 * The raw key is written by POST and never read back here — GET only ever
 * returns a masked preview; the full key is only obtainable via the
 * separate /reveal route, which the UI calls explicitly from an eye-button
 * click rather than on every page load.
 *
 * provider_wix_credentials has no RLS policies at all (see migration
 * 00053), so every read/write here goes through the service-role admin
 * client after requireProviderRole() has confirmed the caller's membership.
 */

export async function GET(request: Request) {
  const providerId = new URL(request.url).searchParams.get('providerId');
  if (!providerId) return NextResponse.json({ error: 'providerId required' }, { status: 400 });

  const auth = await requireProviderRole(request, providerId, 'staff');
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const admin = createAdminClient();
  const { data } = await admin
    .from('provider_wix_credentials')
    .select('wix_site_id, wix_api_key_preview, updated_at')
    .eq('provider_id', providerId)
    .maybeSingle();

  if (!data) return NextResponse.json({ connected: false });
  return NextResponse.json({
    connected: true,
    wix_site_id: data.wix_site_id,
    wix_api_key_preview: data.wix_api_key_preview,
    updated_at: data.updated_at,
  });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    provider_id?: string;
    wix_site_id?: string;
    wix_api_key?: string;
  };
  const { provider_id: providerId, wix_site_id: siteId, wix_api_key: apiKey } = body;
  if (!providerId || !siteId?.trim() || !apiKey?.trim()) {
    return NextResponse.json({ error: 'provider_id, wix_site_id and wix_api_key are required' }, { status: 400 });
  }

  const auth = await requireProviderRole(request, providerId, 'manager');
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const creds = { accessToken: apiKey.trim(), siteId: siteId.trim() };

  // Verify the credentials actually work before saving them — otherwise a
  // typo'd key just sits there looking "connected" until the next sync
  // silently fails.
  try {
    await fetchWixServices(creds);
  } catch {
    return NextResponse.json({ error: 'Could not verify these credentials against Wix — check the key and site ID.' }, { status: 400 });
  }

  const admin = createAdminClient();
  const preview = maskWixApiKey(creds.accessToken);

  const { error } = await admin.from('provider_wix_credentials').upsert(
    {
      provider_id: providerId,
      wix_site_id: creds.siteId,
      wix_api_key: creds.accessToken,
      wix_api_key_preview: preview,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'provider_id' }
  );
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  // Site ID isn't secret (it's a plain account identifier) — mirrored onto
  // providers so existing client-side reads (e.g. ActivitiesPage's Wix busy
  // check) keep working without touching the locked-down credentials table.
  await admin.from('providers').update({ wix_site_id: creds.siteId }).eq('id', providerId);

  // Every service/class/appointment on the account becomes an activity
  // (unpublished until the vendor fills it in) — connecting an account
  // shouldn't require a separate manual step to see anything from it.
  const sync = await syncWixServicesToActivities(admin, providerId, creds);

  return NextResponse.json({ ok: true, wix_api_key_preview: preview, sync });
}

export async function DELETE(request: Request) {
  const providerId = new URL(request.url).searchParams.get('providerId');
  if (!providerId) return NextResponse.json({ error: 'providerId required' }, { status: 400 });

  const auth = await requireProviderRole(request, providerId, 'manager');
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const admin = createAdminClient();
  const { error } = await admin.from('provider_wix_credentials').delete().eq('provider_id', providerId);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  await admin.from('providers').update({ wix_site_id: null }).eq('id', providerId);

  return NextResponse.json({ ok: true });
}
