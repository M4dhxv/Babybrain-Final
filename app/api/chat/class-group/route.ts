import { NextResponse } from 'next/server';
import { getAuthedContext } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { getStreamServerClient } from '@/lib/stream';
import { syncParentClassAccess } from '@/lib/class-chat';

/**
 * A parent's class group chat. The group is per SLOT (session): the parent is
 * taken to the group of the slot they hold a live booking on (next upcoming,
 * else the latest past one), which is created — with the provider's staff — if
 * the vendor hasn't already opened it. Access to any other slot of the class
 * (a cancelled or rescheduled-away booking) is revoked on the way through.
 * No live booking → 403; the parent's private chat with the vendor is a
 * separate channel and is never touched here.
 * Body: { activity_id }.
 */
export async function POST(request: Request) {
  const { activity_id: activityId } = (await request.json().catch(() => ({}))) as { activity_id?: string };
  if (!activityId) {
    return NextResponse.json({ error: 'activity_id required' }, { status: 400 });
  }

  const { user } = await getAuthedContext(request);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  try {
    const admin = createAdminClient();
    const { channelId } = await syncParentClassAccess(admin, activityId, user.id, { ensure: true });
    if (!channelId) {
      return NextResponse.json(
        { error: 'Book this class to join its group chat. You can still message the provider directly.' },
        { status: 403 },
      );
    }
    const stream = getStreamServerClient();
    return NextResponse.json({
      apiKey: process.env.NEXT_PUBLIC_STREAM_KEY,
      token: stream.createToken(user.id),
      channelId,
      userId: user.id,
    });
  } catch (e) {
    console.error('[class-group] failed', e);
    return NextResponse.json({ error: 'Could not open the group chat — please try again.' }, { status: 500 });
  }
}
