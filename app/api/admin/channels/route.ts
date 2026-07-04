import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin';
import { getStreamServerClient } from '@/lib/stream';

/** All conversations, most-recent first, for the admin messaging console. */
export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const stream = getStreamServerClient();
  const channels = await stream.queryChannels(
    { type: 'messaging' },
    { last_message_at: -1 },
    { limit: 40, state: true, watch: false, message_limit: 1 }
  );

  const kindOf = (id: string) =>
    id.startsWith('pp-') ? 'Parent ↔ Provider'
    : id.startsWith('class-') ? 'Class group'
    : id.startsWith('support-') ? 'Support'
    : 'Chat';

  const list = channels.map((ch) => {
    const data = (ch.data ?? {}) as { name?: string };
    const members = Object.values(ch.state.members).map((m) => m.user?.name || m.user?.id || '?');
    const last = ch.state.messages[ch.state.messages.length - 1];
    return {
      id: ch.id,
      kind: kindOf(ch.id ?? ''),
      name: data.name || members.join(', ') || ch.id,
      members,
      memberCount: members.length,
      lastMessage: last
        ? { text: last.text ?? '', at: last.created_at ?? null, userName: last.user?.name || last.user?.id || '' }
        : null,
    };
  });

  return NextResponse.json({ channels: list });
}
