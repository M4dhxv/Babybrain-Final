import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireProviderRole } from '@/lib/vendor';

/**
 * Returns the full, unmasked Wix API key — a deliberate, explicit action
 * (the Settings UI's eye-button click), separate from the normal GET status
 * check so the raw secret is never part of the page's default load. Manager+
 * only, same as saving/disconnecting.
 * Query: ?providerId=<uuid>
 */
export async function GET(request: Request) {
  const providerId = new URL(request.url).searchParams.get('providerId');
  if (!providerId) return NextResponse.json({ error: 'providerId required' }, { status: 400 });

  const auth = await requireProviderRole(request, providerId, 'manager');
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const admin = createAdminClient();
  const { data } = await admin
    .from('provider_wix_credentials')
    .select('wix_api_key')
    .eq('provider_id', providerId)
    .maybeSingle();

  if (!data) return NextResponse.json({ error: 'Not connected' }, { status: 404 });
  return NextResponse.json({ wix_api_key: data.wix_api_key });
}
