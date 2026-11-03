import { useEffect, useState } from "react";
import type { Channel as StreamChannel, StreamChat } from "stream-chat";
import {
  Avatar,
  Chat,
  Channel,
  ChannelList,
  Window,
  MessageList,
  MessageInput,
  Thread,
  useChannelPreviewInfo,
  useChannelStateContext,
  useChatContext,
} from "stream-chat-react";
import "stream-chat-react/dist/css/v2/index.css";
import { getChatClient } from "../lib/chat";
import { Icon } from "./ui";
import { MessagesSkeleton, MESSAGES_BOX } from "./Skeletons";

/**
 * What kind of conversation a channel is, from the fields the server stamps on
 * it: session group chats carry `bb_kind: "session"` (legacy whole-class ones
 * have a `class-` id), provider enquiries carry `bb_parent_id`, and support
 * channels are `support-<user id>`.
 */
type Kind = "enquiry" | "class" | "support" | "other";

function kindOf(channel: StreamChannel): Kind {
  const data = channel.data as { bb_kind?: string; bb_parent_id?: string } | undefined;
  const id = channel.id ?? "";
  if (id.startsWith("support-")) return "support";
  if (data?.bb_kind === "session" || id.startsWith("class-")) return "class";
  if (data?.bb_parent_id) return "enquiry";
  return "other";
}

type FilterKey = "all" | "unread" | "enquiry" | "class" | "support";

const FILTERS: { key: FilterKey; label: string; empty: string }[] = [
  { key: "all", label: "All", empty: "" },
  { key: "unread", label: "Unread", empty: "You're all caught up. No unread conversations." },
  { key: "enquiry", label: "Providers", empty: "No provider conversations yet. Message a provider from a session page to start one." },
  { key: "class", label: "Classes", empty: "No class group chats yet. They appear once a provider starts one for a session you've booked." },
  { key: "support", label: "Support", empty: "No messages with the BabyBrain team yet." },
];

function matches(filter: FilterKey, channel: StreamChannel): boolean {
  if (filter === "all") return true;
  if (filter === "unread") return channel.countUnread() > 0;
  return kindOf(channel) === filter;
}

/** Title bar of the open conversation: back button (mobile), who it's with, and what kind of chat it is. */
function ThreadHeader() {
  const { channel } = useChannelStateContext();
  const { setActiveChannel } = useChatContext();
  const { displayImage, displayTitle } = useChannelPreviewInfo({ channel });
  const kind = kindOf(channel);
  const count = Object.keys(channel.state?.members ?? {}).length;
  const subtitle =
    kind === "class"
      ? `Class group chat · ${count} ${count === 1 ? "member" : "members"}`
      : kind === "support"
        ? "BabyBrain team"
        : kind === "enquiry"
          ? "Provider"
          : "";

  return (
    <div className="flex items-center gap-2 border-b border-[#F4EFF0] bg-white px-2 py-2.5 md:px-4">
      <button
        type="button"
        onClick={() => setActiveChannel?.(undefined)}
        aria-label="Back to all conversations"
        className="grid h-11 w-11 flex-none place-items-center rounded-full text-[#34406f] hover:bg-[#FAF7F7] md:hidden"
      >
        <Icon name="chevron" className="h-5 w-5 rotate-180" />
      </button>
      <Avatar image={displayImage} name={displayTitle} />
      <div className="min-w-0">
        <h2 className="truncate text-base font-black text-[#1F2A44]">{displayTitle}</h2>
        {subtitle && <p className="truncate text-sm font-semibold text-[#68718f]">{subtitle}</p>}
      </div>
    </div>
  );
}

function NoConversationOpen() {
  return (
    <div className="grid h-full place-items-center p-8 text-center">
      <div>
        <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-[#FED7E4] text-baby-cta">
          <Icon name="chat" className="h-6 w-6" />
        </span>
        <p className="mt-3 text-base font-black text-[#1F2A44]">Choose a conversation</p>
        <p className="mt-1 text-sm font-semibold text-[#68718f]">Pick one from the list to read and reply.</p>
      </div>
    </div>
  );
}

/**
 * The list + conversation panes.
 *
 * QA 04/09: "On mobile, when on messages, can't see actual messages. Need to
 * be able to slide to the right or same as on vendor side click on messages
 * which then open to view to conversations and type, send."
 *
 * On desktop both panes stay side by side; on mobile it behaves like WhatsApp —
 * the list is full-width until you tap a conversation, which then takes over
 * with a back button. ChannelList's auto-select on mount is off on mobile so
 * you land on the list rather than straight inside a conversation you didn't
 * pick.
 */
function ChatPanes({
  userId,
  deepLinkChannel,
  isMobile,
  readOnly,
}: {
  userId: string;
  deepLinkChannel?: string;
  isMobile: boolean;
  readOnly: boolean;
}) {
  const { channel } = useChatContext();
  const chatOpen = !!channel;
  const [filter, setFilter] = useState<FilterKey>("all");
  const active = FILTERS.find((f) => f.key === filter)!;

  return (
    <div className="flex h-full">
      <section
        aria-label="Conversations"
        className={`flex min-h-0 w-full flex-col border-r border-[#F4EFF0] md:w-80 md:flex-none ${
          chatOpen ? "hidden md:flex" : "flex"
        }`}
      >
        <div className="px-4 pb-1 pt-4">
          <h2 className="text-xl font-black text-[#1F2A44]">Messages</h2>
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
              className={`min-h-[36px] flex-none rounded-full px-3.5 text-sm font-bold ${
                filter === f.key
                  ? "bg-[#FED7E4] text-baby-cta"
                  : "bg-[#F4EFF0] text-[#59658d] hover:bg-[#EDF7FD]"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto bb-slim-scroll">
          <ChannelList
            filters={{ type: "messaging", members: { $in: [userId] } }}
            sort={{ last_message_at: -1 }}
            options={{ state: true, watch: true, presence: true }}
            showChannelSearch
            additionalChannelSearchProps={{ searchForChannels: true, placeholder: "Search conversations" }}
            customActiveChannel={deepLinkChannel}
            /* Filtering happens on the loaded page of conversations (30 at a
               time, more on scroll) rather than as a server query, so
               "Unread" always reflects what the list is showing right now. */
            channelRenderFilterFn={(channels) => channels.filter((c) => matches(filter, c))}
            /* Mobile lands on the list; desktop still opens the most recent
               conversation on mount. A ?channel= deep link wins on both. */
            setActiveChannelOnMount={!isMobile || !!deepLinkChannel}
            EmptyStateIndicator={() => (
              <div className="p-6 text-center text-sm font-semibold text-[#68718f]">
                {filter !== "all" ? (
                  <>
                    <p>{active.empty}</p>
                    <button
                      type="button"
                      onClick={() => setFilter("all")}
                      className="mt-3 min-h-[44px] rounded-full bg-[#F4EFF0] px-4 font-bold text-[#59658d] hover:bg-[#EDF7FD]"
                    >
                      Show all conversations
                    </button>
                  </>
                ) : readOnly ? (
                  "No conversations yet. Session group chats appear here once a provider starts one for a session you've booked."
                ) : (
                  "No conversations yet. Message a provider from a session page to start one."
                )}
              </div>
            )}
          />
        </div>
        {/* QA 04/09: free parents get the reading half. The composer is
            replaced in the thread; this says the same for the list. */}
        {readOnly && (
          <p className="border-t border-[#F4EFF0] bg-[#EDF7FD] px-4 py-3 text-sm font-semibold text-[#59658d]">
            You can read your conversations. Replying and starting new ones needs{" "}
            <a href="/pricing" className="font-black text-baby-cta underline hover:no-underline">
              Plus
            </a>
            .
          </p>
        )}
      </section>
      <section
        aria-label="Conversation"
        className={`min-w-0 flex-1 md:block ${chatOpen ? "block" : "hidden md:block"}`}
      >
        <Channel EmptyPlaceholder={<NoConversationOpen />}>
          <Window>
            <ThreadHeader />
            <MessageList />
            {/* QA 04/09: "they should be able to see messages on classed booked
                onto but the type & send function be greyed out." Free parents
                get the reading half; the composer is replaced rather than
                disabled, so it explains itself instead of looking broken. */}
            {readOnly ? (
              <div className="border-t border-[#F4EFF0] bg-[#FAF7F7] px-4 py-3 text-sm font-semibold text-[#68718f]">
                Replying is a Plus feature.{" "}
                <a href="/pricing" className="font-black text-baby-cta underline hover:no-underline">
                  Upgrade to join in
                </a>
              </div>
            ) : (
              <MessageInput />
            )}
          </Window>
          <Thread />
        </Channel>
      </section>
    </div>
  );
}

/**
 * Every conversation a Plus parent is part of — provider enquiries, class
 * group chats, support — in one place. QA: "Where do parents paying see
 * messages? Need a tab". Mirrors the vendor portal's MessagesPage.
 *
 * Fills the profile content column to the bottom of the screen (edge to edge on
 * a phone) instead of sitting in a fixed-height card.
 */
export function MessagesTab({ userId, readOnly = false }: { userId: string; readOnly?: boolean }) {
  const [client, setClient] = useState<StreamChat | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deepLinkChannel] = useState(
    () => new URLSearchParams(window.location.search).get("channel") ?? undefined
  );
  /* Resolved synchronously so ChannelList reads the right
     setActiveChannelOnMount on its first render — otherwise mobile flashes an
     auto-opened conversation before falling back to the list. Kept reactive so
     rotating the device re-lays out. */
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth < 768 : false
  );
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const on = () => setIsMobile(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  useEffect(() => {
    let active = true;
    getChatClient()
      .then((c) => active && setClient(c))
      .catch((e) => active && setError(e instanceof Error ? e.message : "Chat unavailable"));
    return () => {
      active = false;
    };
  }, []);

  if (error) {
    return (
      <div className="rounded-[14px] border border-dashed border-[#EBE3E5] bg-[#FAF7F7] p-10 text-center text-sm font-semibold text-[#68718f]">
        Messages unavailable — {error}
      </div>
    );
  }
  if (!client) {
    return <MessagesSkeleton />;
  }

  return (
    <div className={`bb-chat bb-chat-inbox str-chat__theme-light ${MESSAGES_BOX}`}>
      <Chat client={client}>
        <ChatPanes userId={userId} deepLinkChannel={deepLinkChannel} isMobile={isMobile} readOnly={readOnly} />
      </Chat>
    </div>
  );
}
