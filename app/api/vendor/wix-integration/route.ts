import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireProviderRole } from '@/lib/vendor';
import {
  maskWixApiKey,
  fetchWixServices,
  describeWixApiError,
  normalizeWixApiKey,
  normalizeWixSiteId,
  isWixSiteId,
  WixApiError,
} from '@/lib/wix/client';

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

// Every Wix API call is bounded at 20s by wixFetch, and these routes make
// several of them back to back (resolve a slot, create the booking, confirm
// it). On the platform default (~10s) a slow-but-healthy Wix response gets
// the function killed mid-flight and the user sees a bare network error —
// for credentials/bookings that were perfectly fine. Same 60s ceiling the
// other Wix routes already set.
export const maxDuration = 60;

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
  const { provider_id: providerId, wix_site_id: rawSiteId, wix_api_key: rawApiKey } = body;
  if (!providerId || !rawSiteId?.trim() || !rawApiKey?.trim()) {
    return NextResponse.json({ error: 'provider_id, wix_site_id and wix_api_key are required' }, { status: 400 });
  }

  const auth = await requireProviderRole(request, providerId, 'manager');
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  // Tolerate a messy paste: a whole dashboard URL / trailing slash in the
  // Site ID, a wrapped key with newlines, an accidental "Bearer " prefix —
  // all of which Wix would otherwise 403 with a "your key is bad" message.
  const creds = { accessToken: normalizeWixApiKey(rawApiKey), siteId: normalizeWixSiteId(rawSiteId) };
  if (!creds.accessToken || !creds.siteId) {
    return NextResponse.json({ error: 'provider_id, wix_site_id and wix_api_key are required' }, { status: 400 });
  }

  // A Site ID that isn't a UUID (a site *name*, a slug, half a URL) draws
  // the same 403 from Wix that a revoked key does, which sends vendors off
  // to regenerate a key that was never the problem. Catch it here instead,
  // naming the actual mistake — and without spending a Wix round trip.
  if (!isWixSiteId(creds.siteId)) {
    return NextResponse.json(
      {
        error:
          'That doesn’t look like a Wix Site ID. It’s the UUID in your Wix dashboard URL — ' +
          'wix.com/dashboard/SITE_ID/home — for example a240b75d-88bb-414a-bf15-01f112022e66. ' +
          'You can paste the whole URL and we’ll pull the ID out of it.',
      },
      { status: 400 }
    );
  }

  // Verify the credentials actually work before saving them — otherwise a
  // typo'd key just sits there looking "connected" until the next sync
  // silently fails. One retry on a transient failure (rate limit / 5xx /
  // timeout) so a Wix blip doesn't read to the vendor as "wrong key".
  try {
    await fetchWixServices(creds);
  } catch (e) {
    const transient = e instanceof WixApiError && (e.status === 0 || e.status === 429 || e.status >= 500);
    if (transient) {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        await fetchWixServices(creds);
      } catch (e2) {
        console.error('[wix-integration] credential verification failed (after retry):', e2);
        return NextResponse.json({ error: describeWixApiError(e2) }, { status: 400 });
      }
    } else {
      console.error('[wix-integration] credential verification failed:', e);
      return NextResponse.json({ error: describeWixApiError(e) }, { status: 400 });
    }
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

  // Connecting an account no longer imports anything. The vendor then
  // picks which services and events to bring in from the "Import specific
  // activities" / "Import specific events" pickers (POST
  // /api/vendor/wix-services-import and .../wix-events-import); until then
  // this is just a verified, stored credential.
  return NextResponse.json({ ok: true, wix_api_key_preview: preview });
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
