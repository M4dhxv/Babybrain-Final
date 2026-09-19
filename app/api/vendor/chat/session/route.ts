import { NextResponse } from 'next/server';
import { getAuthedContext } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { getStreamServerClient, SUPPORT_USER_ID } from '@/lib/stream';
import { ensureSessionChannel, LIVE_BOOKING_STATUSES } from '@/lib/class-chat';

/**
 * Group chat for everyone booked into a single session ("Message parents" on
 * the vendor Bookings page) — one shared channel for that slot's parents plus
 * the provider's active staff. Same deterministic channel as a parent's
 * "Class group chat" (/api/chat/class-group), so whichever side opens it first
 * creates it and the other joins the existing one.
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
    .in('status', [...LIVE_BOOKING_STATUSES]);
  // Manual/guest bookings (vendor-recorded, no parent account) have a null
  // user_id — they can't be Stream chat members, so exclude them here.
  const memberIds = [
    ...new Set((bookings ?? []).map((b) => b.user_id).filter((id): id is string => id !== null)),
  ];
  if (!memberIds.length) {
    return NextResponse.json({ error: 'No parents with a live booking on this session yet.' }, { status: 400 });
  }

  const res = await ensureSessionChannel(admin, sessionId, memberIds, user.id);
  if (!res) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }
  // Drop parents who no longer hold a live booking on this slot (cancelled or
  // rescheduled away) — the channel may have been created before they left.
  try {
    const stream = getStreamServerClient();
    const state = await stream.channel('messaging', res.channelId).query({ state: true, members: { limit: 100 } });
    const staff = new Set(
      ((await admin.from('provider_members').select('user_id').eq('provider_id', providerId).eq('status', 'active')).data ?? [])
        .map((s) => s.user_id),
    );
    const stale = (state.members ?? [])
      .map((m) => m.user_id)
      .filter((id): id is string => !!id && !memberIds.includes(id) && !staff.has(id) && id !== SUPPORT_USER_ID);
    if (stale.length) await stream.channel('messaging', res.channelId).removeMembers(stale);
  } catch (e) {
    console.error('[session-chat] stale member cleanup failed', e);
  }

  return NextResponse.json({ channelId: res.channelId, memberCount: res.memberCount });
}
