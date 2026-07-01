import { NextResponse } from 'next/server';
import { getAuthedContext } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { getStreamServerClient, providerChannelId } from '@/lib/stream';

/**
 * Parent starts (or reopens) a chat with a provider from an activity page.
 * Creates a deterministic parent↔provider Stream channel whose members are
 * the parent + all active provider staff. Idempotent.
 * Body: { provider_id: string }
 */
export async function POST(request: Request) {
  const { provider_id: providerId } = (await request.json()) as { provider_id?: string };
  if (!providerId) {
    return NextResponse.json({ error: 'provider_id required' }, { status: 400 });
  }

  const { supabase, user } = await getAuthedContext(request);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const admin = createAdminClient();
  const { data: provider } = await admin
    .from('providers')
    .select('business_name, status')
    .eq('id', providerId)
    .maybeSingle();
  if (!provider || provider.status !== 'active') {
    return NextResponse.json({ error: 'Provider not available' }, { status: 404 });
  }

  const { data: staff } = await admin
    .from('provider_members')
    .select('user_id')
    .eq('provider_id', providerId)
    .eq('status', 'active');
  const staffIds = (staff ?? []).map((s) => s.user_id);

  const { data: profile } = await supabase
    .from('parent_profiles')
    .select('full_name')
    .eq('id', user.id)
    .single();

  const stream = getStreamServerClient();
  const channelId = providerChannelId(providerId, user.id);

  await stream.upsertUsers([
    { id: user.id, name: profile?.full_name || user.email || 'Parent' },
    ...staffIds.map((id) => ({ id, name: provider.business_name })),
  ]);

  const channel = stream.channel('messaging', channelId, {
    members: [user.id, ...staffIds],
    created_by_id: user.id,
    // custom fields read by the webhook + UI
    bb_provider_id: providerId,
    bb_parent_id: user.id,
    name: provider.business_name,
  } as never);
  await channel.create();

  return NextResponse.json({
    apiKey: process.env.NEXT_PUBLIC_STREAM_KEY,
    token: stream.createToken(user.id),
    channelId,
    userId: user.id,
  });
}
