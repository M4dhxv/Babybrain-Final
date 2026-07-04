import { NextResponse } from 'next/server';
import { getAuthedContext } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { getStreamServerClient } from '@/lib/stream';

/**
 * Group chat for everyone booked into a given class (activity). Only parents
 * with a live booking may create/join via this route; the channel's members
 * are all such parents PLUS the provider's active staff, so parents can
 * coordinate with each other and the vendor is present to answer.
 * Body: { activity_id }.
 */
export async function POST(request: Request) {
  const { activity_id: activityId } = (await request.json()) as { activity_id?: string };
  if (!activityId) {
    return NextResponse.json({ error: 'activity_id required' }, { status: 400 });
  }

  const { user } = await getAuthedContext(request);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const admin = createAdminClient();

  const { data: sessions } = await admin
    .from('activity_sessions')
    .select('id')
    .eq('activity_id', activityId);
  const sessionIds = (sessions ?? []).map((s) => s.id);
  if (!sessionIds.length) {
    return NextResponse.json({ error: 'Class not found' }, { status: 404 });
  }

  const { data: bookings } = await admin
    .from('bookings')
    .select('user_id')
    .in('session_id', sessionIds)
    .in('status', ['pending', 'confirmed', 'completed']);
  const memberIds = [...new Set((bookings ?? []).map((b) => b.user_id))];

  if (!memberIds.includes(user.id)) {
    return NextResponse.json(
      { error: 'Book this class to join its parent chat.' },
      { status: 403 }
    );
  }

  const { data: activity } = await admin
    .from('activities')
    .select('title, provider_id')
    .eq('id', activityId)
    .single();

  const { data: profiles } = await admin
    .from('parent_profiles')
    .select('id, full_name')
    .in('id', memberIds);
  const nameById = Object.fromEntries((profiles ?? []).map((p) => [p.id, p.full_name]));

  // The provider's active staff join the group too, so the vendor is present
  // to answer alongside the parents. Falls back to a parents-only group when
  // the activity has no linked provider.
  let providerName = 'Provider';
  let staffIds: string[] = [];
  if (activity?.provider_id) {
    const [{ data: provider }, { data: staff }] = await Promise.all([
      admin.from('providers').select('business_name').eq('id', activity.provider_id).maybeSingle(),
      admin
        .from('provider_members')
        .select('user_id')
        .eq('provider_id', activity.provider_id)
        .eq('status', 'active'),
    ]);
    providerName = provider?.business_name || providerName;
    staffIds = (staff ?? []).map((s) => s.user_id).filter((id) => !memberIds.includes(id));
  }

  const stream = getStreamServerClient();
  const channelId = `class-${activityId.slice(0, 12)}`;

  await stream.upsertUsers([
    ...memberIds.map((id) => ({ id, name: nameById[id] || 'Parent' })),
    ...staffIds.map((id) => ({ id, name: providerName })),
  ]);

  const allMembers = [...memberIds, ...staffIds];
  const channel = stream.channel('messaging', channelId, {
    members: allMembers,
    created_by_id: user.id,
    name: `${activity?.title ?? 'Class'} — class group`,
    bb_activity_id: activityId,
    bb_provider_id: activity?.provider_id ?? null,
  } as never);
  await channel.create();
  // Ensure everyone is a member even if the channel pre-existed this booking
  // (new parents booking later, or staff added after the group was created).
  await channel.addMembers([user.id, ...staffIds]);

  return NextResponse.json({
    apiKey: process.env.NEXT_PUBLIC_STREAM_KEY,
    token: stream.createToken(user.id),
    channelId,
    userId: user.id,
    memberCount: allMembers.length,
  });
}
