import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { Channel as StreamChannel, StreamChat } from 'stream-chat';
import {
  Avatar,
  Chat,
  Channel,
  ChannelList,
  Window,
  MessageList,
  MessageInput,
  Thread,
  ChannelPreviewMessenger,
  useChannelPreviewInfo,
  useChannelStateContext,
  useChatContext,
  type ChannelPreviewUIComponentProps,
} from 'stream-chat-react';
import { MessageSquare, ArrowLeft } from 'lucide-react';
import 'stream-chat-react/dist/css/v2/index.css';
import { getChatClient } from '@/lib/chat';
import { useAuth } from '@/auth/AuthProvider';
import { RainbowLoader } from '@/components/ui/rainbow-loader';
import { cn } from '@/lib/utils';

/**
 * Who a parent enquiry is *with*, as the vendor should see it.
 *
 * A parent↔provider channel is created with `name: <the business's name>` so
 * the parent's own inbox reads "Odissi Classes". That one stored name is shown
 * to everyone, so the vendor's inbox listed their own business against every
 * parent. Here the title is the parent's name instead, plus a short code from
 * their id so two parents called "Priya" can be told apart.
 *
 * Only for the 1:1 enquiry channels (they carry `bb_parent_id`); session group
 * channels keep their own name. If the signed-in user is the parent (a vendor
 * who also books as a parent) the business name stays as it is.
 */
function enquiryTitle(channel: StreamChannel, myId: string | undefined): string | null {
  const parentId = (channel.data as { bb_parent_id?: string } | undefined)?.bb_parent_id;
  if (!parentId || parentId === myId) return null;
  const name = channel.state?.members?.[parentId]?.user?.name?.trim() || 'Parent';
  return `${name} · #${parentId.replace(/-/g, '').slice(0, 4).toUpperCase()}`;
}

function EnquiryPreview(props: ChannelPreviewUIComponentProps) {
  const { client } = useChatContext();
  const title = enquiryTitle(props.channel, client.userID);
  return <ChannelPreviewMessenger {...props} displayTitle={title ?? props.displayTitle} />;
}

/** One-to-one parent enquiries carry `bb_parent_id`; session group chats carry `bb_kind: 'session'`. */
type Kind = 'enquiry' | 'class' | 'other';

function kindOf(channel: StreamChannel): Kind {
  const data = channel.data as { bb_kind?: string; bb_parent_id?: string } | undefined;
  if (data?.bb_kind === 'session' || (channel.id ?? '').startsWith('class-')) return 'class';
  if (data?.bb_parent_id) return 'enquiry';
  return 'other';
}

type FilterKey = 'all' | 'unread' | 'enquiry' | 'class';

const FILTERS: { key: FilterKey; label: string; empty: string }[] = [
  { key: 'all', label: 'All', empty: '' },
  { key: 'unread', label: 'Unread', empty: "You're all caught up. No unread conversations." },
  { key: 'enquiry', label: 'Enquiries', empty: 'No parent enquiries yet.' },
  { key: 'class', label: 'Class chats', empty: 'No class group chats yet. Start one from a session to message everyone booked on it.' },
];

function matches(filter: FilterKey, channel: StreamChannel): boolean {
  if (filter === 'all') return true;
  if (filter === 'unread') return channel.countUnread() > 0;
  return kindOf(channel) === filter;
}

/** Title bar of the open conversation: back button (mobile), who it's with, and what kind of chat it is. */
function ThreadHeader() {
  const { channel } = useChannelStateContext();
  const { client, setActiveChannel } = useChatContext();
  const { displayImage, displayTitle } = useChannelPreviewInfo({
    channel,
    overrideTitle: enquiryTitle(channel, client.userID) ?? undefined,
  });
  const kind = kindOf(channel);
  const count = Object.keys(channel.state?.members ?? {}).length;
  const subtitle =
    kind === 'class'
      ? `Class group chat · ${count} ${count === 1 ? 'member' : 'members'}`
      : kind === 'enquiry'
        ? 'Parent enquiry'
        : '';

  return (
    <div className="flex items-center gap-2 border-b border-gray-200 bg-white px-2 py-2.5 md:px-4">
      <button
        type="button"
        onClick={() => setActiveChannel?.(undefined)}
        aria-label="Back to all conversations"
        className="grid h-11 w-11 flex-none place-items-center rounded-full text-gray-700 hover:bg-gray-100 md:hidden"
      >
        <ArrowLeft className="h-5 w-5" />
      </button>
      <Avatar image={displayImage} name={displayTitle} />
      <div className="min-w-0">
        <h2 className="truncate text-base font-semibold text-gray-900">{displayTitle}</h2>
        {subtitle && <p className="truncate text-sm text-gray-500">{subtitle}</p>}
      </div>
    </div>
  );
}

function NoConversationOpen() {
  return (
    <div className="grid h-full place-items-center p-8 text-center">
      <div>
        <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-[#FED7E4] text-[#FA4D8D]">
          <MessageSquare className="h-6 w-6" />
        </span>
        <p className="mt-3 text-base font-semibold text-gray-900">Choose a conversation</p>
        <p className="mt-1 text-sm text-gray-500">Pick one from the list to read and reply.</p>
      </div>
    </div>
  );
}

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
  const { channel } = useChatContext();
  const chatOpen = !!channel;
  const [filter, setFilter] = useState<FilterKey>('all');
  const active = FILTERS.find((f) => f.key === filter)!;

  return (
    <div className="flex h-full">
      <section
        aria-label="Conversations"
        className={cn(
          'flex min-h-0 w-full flex-col border-r border-gray-200 md:w-80 md:flex-none lg:w-96',
          chatOpen ? 'hidden md:flex' : 'flex'
        )}
      >
        <div className="px-4 pb-1 pt-4">
          <h1 className="text-xl font-bold text-gray-900">Messages</h1>
          <p className="text-sm text-gray-500">Every parent enquiry, across all your services.</p>
        </div>
        <div
          role="group"
          aria-label="Filter conversations"
          className="flex gap-2 overflow-x-auto px-4 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              aria-pressed={filter === f.key}
              onClick={() => setFilter(f.key)}
              className={cn(
                'min-h-[36px] flex-none rounded-full px-3.5 text-sm font-medium',
                filter === f.key
                  ? 'bg-[#FED7E4] text-[#C90044]'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
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
            Preview={EnquiryPreview}
            customActiveChannel={deepLinkChannel}
            /* Filtering happens on the loaded page of conversations (30 at a
               time, more on scroll) rather than as a server query, so
               "Unread" always reflects what the list is showing right now. */
            channelRenderFilterFn={(channels) => channels.filter((c) => matches(filter, c))}
            /* Mobile lands on the list (WhatsApp-style); desktop still
               opens the most recent conversation on mount. */
            setActiveChannelOnMount={!isMobile || !!deepLinkChannel}
            EmptyStateIndicator={() => (
              <div className="p-8 text-center text-sm text-gray-500">
                {filter !== 'all' ? (
                  <>
                    <p>{active.empty}</p>
                    <button
                      type="button"
                      onClick={() => setFilter('all')}
                      className="mt-3 min-h-[44px] rounded-full bg-gray-100 px-4 font-medium text-gray-700 hover:bg-gray-200"
                    >
                      Show all conversations
                    </button>
                  </>
                ) : (
                  "No conversations yet. Parents' enquiries will appear here."
                )}
              </div>
            )}
          />
        </div>
      </section>
      <section
        aria-label="Conversation"
        className={cn('min-w-0 flex-1 md:block', chatOpen ? 'block' : 'hidden md:block')}
      >
        <Channel EmptyPlaceholder={<NoConversationOpen />}>
          <Window>
            <ThreadHeader />
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
      </section>
    </div>
  );
}

export default function MessagesPage() {
  const { session, adminView } = useAuth();
  const userId = session?.user.id;
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

  // `retryNonce` re-runs the connect effect without a page reload — this
  // used to be a full-page dead end on any failure (a dropped connection, a
  // slow Stream edge) with no way back short of hitting F5.
  const [retryNonce, setRetryNonce] = useState(0);
  useEffect(() => {
    // Admin view isn't a member of the vendor's chats (00251), so connecting
    // would only open an empty inbox under the admin's own chat identity.
    if (adminView) return;
    let active = true;
    getChatClient()
      .then((c) => active && setClient(c))
      .catch((e) => active && setError(e instanceof Error ? e.message : 'Chat unavailable'));
    return () => {
      active = false;
    };
  }, [retryNonce, adminView]);

  if (adminView) {
    return (
      <div className="p-4 sm:p-8">
        <div className="max-w-md mx-auto text-center bg-white rounded-xl border border-gray-200 p-10">
          <MessageSquare className="w-10 h-10 text-gray-300 mx-auto mb-3" />
          <h3 className="font-semibold text-gray-900">Messages aren't shown in admin view</h3>
          <p className="text-sm text-gray-500 mt-1">This vendor's parent chats are in the admin portal, under Messages.</p>
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
          <button
            type="button"
            onClick={() => { setError(null); setRetryNonce((n) => n + 1); }}
            className="mt-4 rounded-lg bg-[#FA4D8D] px-4 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            Try again
          </button>
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

  /* Fills the whole content area beside the sidebar — no page title block, no
     padding, no card border. The "Messages" heading lives in the list pane.
     `bb-chat` is what the dark-pink Stream override in index.css hangs off;
     `bb-chat-inbox` is the roomier full-height styling. */
  return (
    <div className="bb-chat bb-chat-inbox h-full bg-white str-chat__theme-light">
      <Chat client={client}>
        <ChatPanes userId={userId} deepLinkChannel={deepLinkChannel} isMobile={isMobile} />
      </Chat>
    </div>
  );
}
