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
  useChatContext,
} from 'stream-chat-react';
import { MessageSquare, Crown, ArrowLeft } from 'lucide-react';
import 'stream-chat-react/dist/css/v2/index.css';
import { getChatClient } from '@/lib/chat';
import { useAuth } from '@/auth/AuthProvider';
import { Button } from '@/components/ui/button';
import { RainbowLoader } from '@/components/ui/rainbow-loader';
import { cn } from '@/lib/utils';

/**
 * The list + conversation panes. On desktop both are always visible
 * (list fixed-width, conversation fills the rest). On mobile it behaves
 * like WhatsApp: the conversation list is full-width until you tap a
 * conversation, which then takes over the screen with a "back" button;
 * ChannelList's mount auto-select is off on mobile so you land on the
 * list, not straight inside a chat.
 */
function ChatPanes({
  userId,
  deepLinkChannel,
  isMobile,
}: {
  userId: string;
  deepLinkChannel?: string;
  isMobile: boolean;
}) {
  const { channel, setActiveChannel } = useChatContext();
  const chatOpen = !!channel;

  return (
    <div className="flex h-full">
      <div
        className={cn(
          'w-full overflow-y-auto border-r border-gray-200 md:block md:w-80',
          chatOpen ? 'hidden md:block' : 'block'
        )}
      >
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
          /* Mobile lands on the list (WhatsApp-style); desktop still
             opens the most recent conversation on mount. */
          setActiveChannelOnMount={!isMobile || !!deepLinkChannel}
          EmptyStateIndicator={() => (
            <div className="p-8 text-center text-sm text-gray-400">
              No conversations yet. Parents' enquiries will appear here.
            </div>
          )}
        />
      </div>
      <div
        className={cn(
          'min-w-0 flex-1 md:block',
          chatOpen ? 'block' : 'hidden md:block'
        )}
      >
        <Channel>
          <Window>
            <button
              type="button"
              onClick={() => setActiveChannel?.(undefined)}
              className="flex w-full items-center gap-2 border-b border-gray-200 px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50 md:hidden"
            >
              <ArrowLeft className="h-4 w-4" /> All conversations
            </button>
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
  );
}

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
  // Resolved synchronously so ChannelList reads the right
  // setActiveChannelOnMount on its first render (no mobile-flash of an
  // auto-opened conversation). Kept reactive for orientation changes.
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth < 768 : false
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const on = () => setIsMobile(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

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
      <div className="p-4 text-center sm:p-8 sm:text-left">
        <h1 className="text-2xl font-bold text-gray-900">Messages</h1>
        <p className="mt-1 text-sm text-gray-500">Every parent enquiry, across all your services, in one inbox.</p>
        <div className="mt-6 rounded-xl border border-dashed border-primary/30 bg-bb-pink-light/60 p-10 text-center">
          <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-primary text-primary-foreground">
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
      <div className="p-4 sm:p-8">
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
      <div className="flex flex-col items-center justify-center h-full gap-3 text-gray-400">
        <RainbowLoader label="Connecting to messages" />
        <span className="text-sm">Connecting to messages…</span>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-4 py-5 sm:px-8">
        <div className="w-full text-center sm:w-auto sm:text-left">
          <h1 className="text-2xl font-bold text-gray-900">Messages</h1>
          <p className="text-sm text-gray-500 mt-1">Every parent enquiry, across all your services, in one inbox.</p>
        </div>
      </div>
      <div className="min-h-0 flex-1 px-4 pb-6 sm:px-6">
      {/* `bb-chat` is what the dark-pink Stream override in index.css hangs off. */}
      <div className="bb-chat h-full rounded-xl border border-gray-200 overflow-hidden bg-white str-chat__theme-light">
        <Chat client={client}>
          <ChatPanes userId={userId} deepLinkChannel={deepLinkChannel} isMobile={isMobile} />
        </Chat>
      </div>
      </div>
    </div>
  );
}
