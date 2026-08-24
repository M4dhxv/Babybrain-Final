import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { StreamChat } from 'stream-chat';
import {
  Chat,
  Channel,
  ChannelList,
  Window,
  ChannelHeader,
  MessageList,
  MessageInput,
  Thread,
} from 'stream-chat-react';
import { MessageSquare, Loader2, Crown } from 'lucide-react';
import 'stream-chat-react/dist/css/v2/index.css';
import { getChatClient } from '@/lib/chat';
import { useAuth } from '@/auth/AuthProvider';
import { Button } from '@/components/ui/button';

export default function MessagesPage() {
  const { session, subscription } = useAuth();
  const navigate = useNavigate();
  const userId = session?.user.id;
  // Messaging is a Growth-and-above perk (see plans.ts PLAN_META) — the
  // sidebar shows this tab greyed on Pay As You Grow, but a vendor could
  // still land here by URL, so the page itself has to enforce it too.
  const plan = subscription?.plan ?? 'free';
  const canMessage = plan === 'growth' || plan === 'pro' || plan === 'premium';
  const [client, setClient] = useState<StreamChat | null>(null);
  const [error, setError] = useState<string | null>(null);
  // ?channel=<id> deep-links straight into a conversation (e.g. a booking's
  // "Message parent" action). customActiveChannel selects it on mount
  // instead of ChannelList's default "select the first channel" behavior.
  const [params, setParams] = useSearchParams();
  const [deepLinkChannel] = useState(() => params.get('channel') ?? undefined);

  useEffect(() => {
    if (!params.get('channel')) return;
    setParams((p) => {
      p.delete('channel');
      return p;
    }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!canMessage) return;
    let active = true;
    getChatClient()
      .then((c) => active && setClient(c))
      .catch((e) => active && setError(e instanceof Error ? e.message : 'Chat unavailable'));
    return () => {
      active = false;
    };
  }, [canMessage]);

  if (!canMessage) {
    return (
      <div className="p-8">
        <h1 className="text-2xl font-bold text-gray-900">Messages</h1>
        <p className="mt-1 text-sm text-gray-500">Parents and providers, in one inbox.</p>
        <div className="mt-6 rounded-xl border border-dashed border-purple-300 bg-purple-50/40 p-10 text-center">
          <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-purple-300 text-purple-800">
            <Crown className="h-7 w-7" />
          </span>
          <h2 className="mt-4 text-xl font-bold text-gray-900">Messaging is a Pro feature</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-gray-600">
            Message parents directly and reply to their enquiries once you're on Pro or above.
          </p>
          <Button onClick={() => navigate('/plans')} className="mt-5 gradient-primary text-white">
            Go Pro
          </Button>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8">
        <div className="max-w-md mx-auto text-center bg-white rounded-xl border border-gray-200 p-10">
          <MessageSquare className="w-10 h-10 text-gray-300 mx-auto mb-3" />
          <h3 className="font-semibold text-gray-900">Messages unavailable</h3>
          <p className="text-sm text-gray-500 mt-1">{error}</p>
        </div>
      </div>
    );
  }

  if (!client || !userId) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400 gap-2">
        <Loader2 className="w-5 h-5 animate-spin" /> Connecting to messages…
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-8 py-5">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Messages</h1>
          <p className="text-sm text-gray-500 mt-1">Parents and providers, in one inbox.</p>
        </div>
      </div>
      <div className="min-h-0 flex-1 px-6 pb-6">
      <div className="h-full rounded-xl border border-gray-200 overflow-hidden bg-white str-chat__theme-light">
        <Chat client={client}>
          <div className="flex h-full">
            <div className="w-80 border-r border-gray-200 overflow-y-auto">
              <ChannelList
                filters={{ type: 'messaging', members: { $in: [userId] } }}
                sort={{ last_message_at: -1 }}
                options={{ state: true, watch: true, presence: true }}
                /* QA: "the search messages function ... doesn't work". There was
                   no search at all — this turns on Stream's own, which queries
                   the server rather than filtering only what's loaded. */
                showChannelSearch
                additionalChannelSearchProps={{
                  searchForChannels: true,
                  placeholder: 'Search conversations',
                }}
                customActiveChannel={deepLinkChannel}
                EmptyStateIndicator={() => (
                  <div className="p-8 text-center text-sm text-gray-400">
                    No conversations yet. Parents' enquiries will appear here.
                  </div>
                )}
              />
            </div>
            <div className="flex-1 min-w-0">
              <Channel>
                <Window>
                  <ChannelHeader />
                  {/* QA: "not sure what the pen edit button would be intended
                      to do under messages but currently doesn't work". It's
                      Stream's stock "edit my own message" action (hover a
                      sent message → "…" → the pencil) — it does work, but
                      editing a message after a parent has read it isn't a
                      function that makes sense for booking conversations, so
                      it's dropped rather than kept as a confusing no-op. */}
                  <MessageList messageActions={['delete', 'flag', 'quote', 'react', 'reply']} />
                  <MessageInput />
                </Window>
                <Thread />
              </Channel>
            </div>
          </div>
        </Chat>
      </div>
      </div>
    </div>
  );
}
