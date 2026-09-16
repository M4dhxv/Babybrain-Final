import { NextResponse } from 'next/server';
import { getAuthedContext } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { getStreamServerClient, sessionChannelId } from '@/lib/stream';

/**
 * Group chat for everyone booked into a single session ("Message parents" on
 * the vendor Bookings page) — one shared channel for that slot's parents plus
 * the provider's active staff. Scoped to the session rather than the whole
 * class (contrast with /api/chat/class-group, which is parent-initiated and
 * spans every session of the activity).
 * Body: { session_id }
 */
export async function POST(request: Request) {
  const { session_id: sessionId } = (await request.json()) as { session_id?: string };
  if (!sessionId) {
    return NextResponse.json({ error: 'session_id required' }, { status: 400 });
  }

  const { user } = await getAuthedContext(request);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const admin = createAdminClient();

  const { data: sessionRow } = await admin
    .from('activity_sessions')
    .select('activity_id, starts_at')
    .eq('id', sessionId)
    .maybeSingle();
  if (!sessionRow) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }
  const { data: activity } = await admin
    .from('activities')
    .select('title, provider_id')
    .eq('id', sessionRow.activity_id)
    .maybeSingle();
  if (!activity?.provider_id) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }
  const providerId = activity.provider_id;

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

  const { data: bookings } = await admin
    .from('bookings')
    .select('user_id')
    .eq('session_id', sessionId)
    .in('status', ['pending', 'confirmed', 'completed']);
  // Manual/guest bookings (vendor-recorded, no parent account) have a null
  // user_id — they can't be Stream chat members, so exclude them here.
  const memberIds = [
    ...new Set((bookings ?? []).map((b) => b.user_id).filter((id): id is string => id !== null)),
  ];
  if (!memberIds.length) {
    return NextResponse.json({ error: 'No parents with a live booking on this session yet.' }, { status: 400 });
  }

  const [{ data: provider }, { data: profiles }, { data: staff }] = await Promise.all([
    admin.from('providers').select('business_name').eq('id', providerId).maybeSingle(),
    admin.from('parent_profiles').select('id, full_name').in('id', memberIds),
    admin.from('provider_members').select('user_id').eq('provider_id', providerId).eq('status', 'active'),
  ]);
  const providerName = provider?.business_name || 'Provider';
  const nameById = Object.fromEntries((profiles ?? []).map((p) => [p.id, p.full_name]));
  const staffIds = (staff ?? []).map((s) => s.user_id);

  const stream = getStreamServerClient();
  const channelId = sessionChannelId(sessionId);
  const slotLabel = new Date(sessionRow.starts_at).toLocaleString('en-SG', {
    timeZone: 'Asia/Singapore', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
  });

  await stream.upsertUsers([
    ...memberIds.map((id) => ({ id, name: nameById[id] || 'Parent' })),
    ...staffIds.map((id) => ({ id, name: providerName })),
  ]);

  const allMembers = [...new Set([...memberIds, ...staffIds])];
  const channel = stream.channel('messaging', channelId, {
    members: allMembers,
    created_by_id: user.id,
    name: `${activity.title} — ${slotLabel}`,
    bb_provider_id: providerId,
    bb_session_id: sessionId,
  } as never);
  await channel.create();
  // Ensure everyone is a member even if the channel pre-existed this booking
  // (new parents booking later, or staff added after the group was created).
  await channel.addMembers(allMembers);

  return NextResponse.json({ channelId, memberCount: allMembers.length });
}
