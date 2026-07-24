import { NextResponse } from 'next/server';
import { getAuthedContext } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { getStreamServerClient, providerChannelId } from '@/lib/stream';

/**
 * Staff opens (or reopens) a chat with a specific parent, e.g. from a
 * booking's "Message parent" action. Mirrors /api/vendor/chat/start (which
 * is parent-initiated) but staff-initiated — the caller must be an active
 * member of the provider. Reuses the same deterministic channel id as the
 * parent-side route, so either side reaches the same conversation.
 * Body: { provider_id, parent_user_id }
 */
export async function POST(request: Request) {
  try {
    const { provider_id: providerId, parent_user_id: parentId } = (await request.json()) as {
      provider_id?: string;
      parent_user_id?: string;
    };
    if (!providerId || !parentId) {
      return NextResponse.json({ error: 'provider_id and parent_user_id required' }, { status: 400 });
    }

    const { user } = await getAuthedContext(request);
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    const admin = createAdminClient();

    const { data: membership } = await admin
      .from('provider_members')
      .select('user_id')
      .eq('provider_id', providerId)
      .eq('user_id', user.id)
      .eq('status', 'active')
      .maybeSingle();
    if (!membership) {
      return NextResponse.json({ error: 'Not authorized for this provider' }, { status: 403 });
    }

    const [{ data: provider }, { data: parentProfile }, { data: staff }] = await Promise.all([
      admin.from('providers').select('business_name').eq('id', providerId).maybeSingle(),
      admin.from('parent_profiles').select('full_name').eq('id', parentId).maybeSingle(),
      admin.from('provider_members').select('user_id').eq('provider_id', providerId).eq('status', 'active'),
    ]);
    const staffIds = (staff ?? []).map((s) => s.user_id);
    const providerName = provider?.business_name || 'Provider';

    const stream = getStreamServerClient();
    const channelId = providerChannelId(providerId, parentId);

    await stream.upsertUsers([
      { id: parentId, name: parentProfile?.full_name || 'Parent' },
      ...staffIds.map((id) => ({ id, name: providerName })),
    ]);

    const channel = stream.channel('messaging', channelId, {
      members: [...new Set([parentId, ...staffIds])],
      created_by_id: user.id,
      bb_provider_id: providerId,
      bb_parent_id: parentId,
      name: providerName,
    } as never);
    await channel.create();

    return NextResponse.json({ channelId });
  } catch (e) {
    // TEMP: surface the real error while debugging a 500 in production.
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : null },
      { status: 500 }
    );
  }
}
