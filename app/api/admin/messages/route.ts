import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin';
import { getStreamServerClient, SUPPORT_USER_ID } from '@/lib/stream';

/** Read a conversation's recent messages. */
export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const channelId = new URL(request.url).searchParams.get('channelId');
  if (!channelId) return NextResponse.json({ error: 'channelId required' }, { status: 400 });

  const stream = getStreamServerClient();
  const channel = stream.channel('messaging', channelId);
  const state = await channel.query({ messages: { limit: 60 } });

  const messages = (state.messages ?? []).map((m) => ({
    id: m.id,
    text: m.text ?? '',
    at: m.created_at ?? null,
    userId: m.user?.id ?? '',
    userName: m.user?.name || m.user?.id || '',
    isSupport: m.user?.id === SUPPORT_USER_ID,
  }));

  return NextResponse.json({ messages });
}

/**
 * Reply into any channel as BabyBrain Support. Lets the founder answer a
 * user↔vendor thread, a class group, or a support conversation from one place.
 */
export async function POST(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { channelId, text } = (await request.json()) as { channelId?: string; text?: string };
  if (!channelId || !text?.trim()) {
    return NextResponse.json({ error: 'channelId and text required' }, { status: 400 });
  }

  const stream = getStreamServerClient();
  await stream.upsertUser({ id: SUPPORT_USER_ID, name: 'BabyBrain Support' });

  const channel = stream.channel('messaging', channelId);
  // Ensure the support identity can post into this channel.
  await channel.addMembers([SUPPORT_USER_ID]);
  const res = await channel.sendMessage({ text: text.trim(), user_id: SUPPORT_USER_ID });

  return NextResponse.json({
    message: {
      id: res.message.id,
      text: res.message.text ?? '',
      at: res.message.created_at ?? null,
      userId: SUPPORT_USER_ID,
      userName: 'BabyBrain Support',
      isSupport: true,
    },
  });
}
