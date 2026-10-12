import { NextResponse } from 'next/server';
import { verifyAndParseWebhook } from 'stream-chat';
import { createAdminClient } from '@/lib/supabase/admin';
import { SUPPORT_USER_ID, getStreamServerClient } from '@/lib/stream';

// Channel members that are real BabyBrain accounts. Stream also holds non-user
// members (e.g. the babybrain-support user); notifications.user_id is a foreign
// key to auth.users, so one of those would fail the whole batch insert.
const isUserId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

/** The notification title for a chat message: "Ind-SG Kids Center 3 messages", "Priya 1 message". */
const countTitle = (name: string, n: number) => `${name} ${n} ${n === 1 ? 'message' : 'messages'}`;

/**
 * How many unread messages each member of a channel has, from Stream's read state. The message
 * that just arrived is included. Returns an empty map on any failure and callers then say 1,
 * so a Stream hiccup never costs a notification.
 */
async function unreadByUser(channelId: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const state = await getStreamServerClient().channel('messaging', channelId).query({ state: true, messages: { limit: 0 } });
    for (const r of state.read ?? []) out.set(r.user.id, r.unread_messages ?? 0);
  } catch {
    // fall back to 1
  }
  return out;
}
const unreadFor = (counts: Map<string, number>, uid: string) => Math.max(1, counts.get(uid) ?? 0);

/**
 * GetStream webhook (configure URL in the Stream Dashboard after deploy).
 * On message.new from support → in-app notification for the parent
 * (which in turn fans out to email via the notifications DB trigger).
 * On message.new in a parent↔provider channel → notification for whichever
 * side didn't send it, typed per recipient (parent vs. vendor staff).
 * On message.new in a class group chat (class-/session-) → one "new messages
 * in <group>" notification per member, throttled to one pending per person
 * per group. All chat emails are held 4h and skipped if already read.
 */
export async function POST(request: Request) {
  // Raw bytes, not request.text(): Stream gzips hook payloads by default for
  // apps created after 7 May 2026 (ours is), and signs the *uncompressed*
  // body. Hashing the gzipped text failed every signature, so no chat
  // notification or email was ever created. The SDK helper gunzips when the
  // body is compressed and verifies either way.
  const rawBody = Buffer.from(await request.arrayBuffer());
  const signature = request.headers.get('x-signature') ?? '';

  let parsed: unknown;
  try {
    parsed = verifyAndParseWebhook(rawBody, signature, process.env.STREAM_SECRET!);
  } catch (e) {
    console.error('[stream webhook] rejected:', e instanceof Error ? e.message : e, {
      contentEncoding: request.headers.get('content-encoding'),
    });
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  const event = parsed as {
    type?: string;
    channel_id?: string;
    user?: { id?: string; name?: string };
    message?: { text?: string; user?: { id?: string; name?: string } };
    members?: { user_id?: string; user?: { id?: string } }[];
  };

  if (event.type !== 'message.new') {
    return NextResponse.json({ ok: true });
  }

  const admin = createAdminClient();
  const text = (event.message?.text ?? '').slice(0, 300);
  // Who sent it, for the notification title. A provider's staff are registered in the chat with the
  // business name, a parent with their name (or email when they never set one: never put an email
  // address in a lock-screen notification, so that reads as no name).
  const rawSender = (event.user?.name ?? event.message?.user?.name ?? '').trim();
  const senderName = rawSender && !rawSender.includes('@') ? rawSender.slice(0, 60) : '';

  // ---- BabyBrain Support → parent ----
  if (event.user?.id === SUPPORT_USER_ID && event.channel_id?.startsWith('support-')) {
    const parentId = event.channel_id.slice('support-'.length);
    const supportUnread = await unreadByUser(event.channel_id);
    const { error } = await admin.from('notifications').insert({
      user_id: parentId,
      type: 'support_message',
      title: countTitle('BabyBrain Support', unreadFor(supportUnread, parentId)),
      body: text,
      data: { url: '/support' },
    });
    if (error) console.error('[stream webhook] support notification insert failed:', error.message);
  }

  // ---- Parent ↔ provider (pp-*) → notify every member except the sender ----
  if (event.channel_id?.startsWith('pp-')) {
    const senderId = event.user?.id;
    const recipients = (event.members ?? [])
      .map((m) => m.user_id ?? m.user?.id)
      .filter((id): id is string => Boolean(id) && id !== senderId && isUserId(id as string));
    if (recipients.length > 0) {
      // A channel member is either the parent or one of the provider's active
      // staff — look that up so each side gets its own notification type
      // (and email template/link) instead of every recipient being labelled
      // 'provider_message' regardless of which side they're actually on.
      const { data: staffRows } = await admin
        .from('provider_members')
        .select('user_id')
        .in('user_id', recipients)
        .eq('status', 'active');
      const staffIds = new Set((staffRows ?? []).map((r) => r.user_id as string));

      // "Ind-SG Kids Center 3 messages" (a parent reading the provider's replies) or "Priya 1 message"
      // (a provider reading a parent's message): who, and how many are waiting.
      const unread = await unreadByUser(event.channel_id);
      const { error } = await admin.from('notifications').insert(
        recipients.map((uid) =>
          staffIds.has(uid)
            ? { user_id: uid, type: 'provider_message_response', title: countTitle(senderName || 'A parent', unreadFor(unread, uid)), body: text, data: { url: `/vendor/#/messages?channel=${encodeURIComponent(event.channel_id ?? '')}`, channel_id: event.channel_id, sender_name: senderName || null } }
            : { user_id: uid, type: 'provider_message', title: countTitle(senderName || 'Your provider', unreadFor(unread, uid)), body: text, data: { url: `/profile?tab=messages&channel=${encodeURIComponent(event.channel_id ?? '')}`, channel_id: event.channel_id, sender_name: senderName || null } }
        )
      );
      if (error) console.error('[stream webhook] notification insert failed:', error.message, { channel: event.channel_id });
    }
  }

  // ---- Class group chat (class-* / session-*) → notify members, throttled ----
  const channelId = event.channel_id;
  if (channelId && (channelId.startsWith('class-') || channelId.startsWith('session-'))) {
    const senderId = event.user?.id;
    const members = (event.members ?? [])
      .map((m) => m.user_id ?? m.user?.id)
      .filter((id): id is string => Boolean(id) && id !== senderId && isUserId(id as string));

    // One email per person per group per quiet spell: anyone whose last group
    // email for this channel hasn't gone out yet gets no further email. Without
    // this a busy group would email every parent for every message. That limit is
    // for email only: they still get a notification row (email 'skipped'), so every
    // message is pushed. Previously they were dropped entirely, which silently
    // stopped group pushes for hours after the first message.
    const { data: waiting } = members.length
      ? await admin
          .from('notifications')
          .select('user_id')
          .in('type', ['class_group_message', 'provider_class_group_message'])
          .eq('email_status', 'pending')
          .eq('data->>channel_id', channelId)
          .in('user_id', members)
      : { data: [] as { user_id: string }[] };
    const already = new Set((waiting ?? []).map((r) => r.user_id as string));
    const recipients = members;

    if (recipients.length > 0) {
      let groupName: string | null = null;
      try {
        const res = await getStreamServerClient().queryChannels(
          { type: 'messaging', id: channelId },
          {},
          { limit: 1, state: false, watch: false }
        );
        groupName = ((res[0]?.data as { name?: string } | undefined)?.name) ?? null;
      } catch {
        // The email reads fine without a name.
      }

      const { data: staffRows } = await admin
        .from('provider_members')
        .select('user_id')
        .in('user_id', recipients)
        .eq('status', 'active');
      const staffIds = new Set((staffRows ?? []).map((r) => r.user_id as string));
      // Title: who and how many ("Ind-SG Kids Center 3 messages"); body: which group, then the text.
      const unread = await unreadByUser(channelId);
      const groupBody = (groupName ? `${groupName}: ${text}` : text).slice(0, 300);

      const { error } = await admin.from('notifications').insert(
        recipients.map((uid) =>
          staffIds.has(uid)
            ? { user_id: uid, type: 'provider_class_group_message', title: countTitle(senderName || 'Class group', unreadFor(unread, uid)), body: groupBody, data: { url: `/vendor/#/messages?channel=${encodeURIComponent(channelId)}`, channel_id: channelId, group_name: groupName }, ...(already.has(uid) ? { email_status: 'skipped' } : {}) }
            : { user_id: uid, type: 'class_group_message', title: countTitle(senderName || 'Class group', unreadFor(unread, uid)), body: groupBody, data: { url: `/profile?tab=messages&channel=${encodeURIComponent(channelId)}`, channel_id: channelId, group_name: groupName }, ...(already.has(uid) ? { email_status: 'skipped' } : {}) }
        ) as never // email_status is a real column the generated insert type doesn't list
      );
      if (error) console.error('[stream webhook] group notification insert failed:', error.message, { channel: channelId });
    }
  }

  return NextResponse.json({ ok: true });
}
