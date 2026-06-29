import { createHmac, timingSafeEqual } from 'crypto';
import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { SUPPORT_USER_ID } from '@/lib/stream';

/**
 * GetStream webhook (configure URL in the Stream Dashboard after deploy).
 * On message.new from support → in-app notification for the parent
 * (which in turn fans out to email via the notifications DB trigger).
 */
export async function POST(request: Request) {
  const rawBody = await request.text();
  const signature = request.headers.get('x-signature') ?? '';

  const expected = createHmac('sha256', process.env.STREAM_SECRET!)
    .update(rawBody)
    .digest('hex');
  const valid =
    signature.length === expected.length &&
    timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  if (!valid) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  const event = JSON.parse(rawBody) as {
    type?: string;
    channel_id?: string;
    user?: { id?: string };
    message?: { text?: string };
    members?: { user_id?: string; user?: { id?: string } }[];
  };

  if (event.type !== 'message.new') {
    return NextResponse.json({ ok: true });
  }

  const admin = createAdminClient();
  const text = (event.message?.text ?? '').slice(0, 300);

  // ---- BabyBrain Support → parent ----
  if (event.user?.id === SUPPORT_USER_ID && event.channel_id?.startsWith('support-')) {
    const parentId = event.channel_id.slice('support-'.length);
    await admin.from('notifications').insert({
      user_id: parentId,
      type: 'support_message',
      title: 'New message from BabyBrain Support',
      body: text,
      data: { url: '/support' },
    });
  }

  // ---- Parent ↔ provider (pp-*) → notify every member except the sender ----
  if (event.channel_id?.startsWith('pp-')) {
    const senderId = event.user?.id;
    const recipients = (event.members ?? [])
      .map((m) => m.user_id ?? m.user?.id)
      .filter((id): id is string => Boolean(id) && id !== senderId);
    if (recipients.length > 0) {
      await admin.from('notifications').insert(
        recipients.map((uid) => ({
          user_id: uid,
          type: 'provider_message',
          title: 'New message',
          body: text,
          data: { url: '/messages', channel_id: event.channel_id },
        }))
      );
    }
  }

  return NextResponse.json({ ok: true });
}
