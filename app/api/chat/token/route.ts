import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getStreamServerClient, SUPPORT_USER_ID, supportChannelId } from '@/lib/stream';

/**
 * Mints a GetStream user token for the logged-in parent and ensures
 * their support channel exists. Idempotent — safe to call on every
 * visit to /support.
 */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const { data: profile } = await supabase
    .from('parent_profiles')
    .select('full_name')
    .eq('id', user.id)
    .single();
  const name = profile?.full_name || user.email || 'Parent';

  const stream = getStreamServerClient();
  const channelId = supportChannelId(user.id);

  await stream.upsertUsers([
    { id: user.id, name },
    { id: SUPPORT_USER_ID, name: 'BabyBrain Support' },
  ]);

  const channel = stream.channel('messaging', channelId, {
    members: [user.id, SUPPORT_USER_ID],
    created_by_id: SUPPORT_USER_ID,
  });
  await channel.create();

  const admin = createAdminClient();
  await admin.from('stream_users').upsert(
    {
      user_id: user.id,
      stream_user_id: user.id,
      support_channel_id: channelId,
    },
    { onConflict: 'user_id' }
  );

  return NextResponse.json({
    apiKey: process.env.NEXT_PUBLIC_STREAM_KEY,
    token: stream.createToken(user.id),
    channelId,
    userId: user.id,
    name,
  });
}
