import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
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
  useChatContext,
} from 'stream-chat-react';
import { MessageSquare, Loader2 } from 'lucide-react';
import 'stream-chat-react/dist/css/v2/index.css';
import { getChatClient } from '@/lib/chat';
import { useAuth } from '@/auth/AuthProvider';

/**
 * Opens a specific channel when navigated to with ?channel=<id> (e.g. from
 * a booking's "Message parent" action), then clears the param so it doesn't
 * re-fire on a later ChannelList selection.
 */
function DeepLinkChannel() {
  const { client, setActiveChannel } = useChatContext();
  const [params, setParams] = useSearchParams();
  const channelId = params.get('channel');

  useEffect(() => {
    if (!channelId) return;
    let active = true;
    const channel = client.channel('messaging', channelId);
    channel.watch().then(() => {
      if (active) setActiveChannel(channel);
    });
    setParams((p) => {
      p.delete('channel');
      return p;
    }, { replace: true });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]);

  return null;
}

export default function MessagesPage() {
  const { session } = useAuth();
  const userId = session?.user.id;
  const [client, setClient] = useState<StreamChat | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getChatClient()
      .then((c) => active && setClient(c))
      .catch((e) => active && setError(e instanceof Error ? e.message : 'Chat unavailable'));
    return () => {
      active = false;
    };
  }, []);

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
    <div className="h-full p-6">
      <div className="h-full rounded-xl border border-gray-200 overflow-hidden bg-white str-chat__theme-light">
        <Chat client={client}>
          <DeepLinkChannel />
          <div className="flex h-full">
            <div className="w-80 border-r border-gray-200 overflow-y-auto">
              <ChannelList
                filters={{ type: 'messaging', members: { $in: [userId] } }}
                sort={{ last_message_at: -1 }}
                options={{ state: true, watch: true, presence: true }}
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
                  <MessageList />
                  <MessageInput />
                </Window>
                <Thread />
              </Channel>
            </div>
          </div>
        </Chat>
      </div>
    </div>
  );
}
