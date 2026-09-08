import { useEffect, useState } from "react";
import type { StreamChat } from "stream-chat";
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
} from "stream-chat-react";
import "stream-chat-react/dist/css/v2/index.css";
import { getChatClient } from "../lib/chat";
import { Icon } from "./ui";
import { MessagesSkeleton } from "./Skeletons";

/**
 * The list + conversation panes.
 *
 * QA 04/09: "On mobile, when on messages, can't see actual messages. Need to
 * be able to slide to the right or same as on vendor side click on messages
 * which then open to view to conversations and type, send."
 *
 * The two panes were a plain flex row with a fixed 288px list, so at 375px the
 * conversation was left about 87px — present, but unusable. This is the vendor
 * portal's pattern (MessagesPage), which already solved it: on desktop both
 * panes stay side by side; on mobile it behaves like WhatsApp — the list is
 * full-width until you tap a conversation, which then takes over with a back
 * button. ChannelList's auto-select on mount is off on mobile so you land on
 * the list rather than straight inside a conversation you didn't pick.
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
  const { channel, setActiveChannel } = useChatContext();
  const chatOpen = !!channel;

  return (
    <div className="flex h-full">
      <div
        className={`w-full overflow-y-auto border-r border-[#F4EFF0] md:block md:w-72 ${
          chatOpen ? "hidden md:block" : "block"
        }`}
      >
        <ChannelList
          filters={{ type: "messaging", members: { $in: [userId] } }}
          sort={{ last_message_at: -1 }}
          options={{ state: true, watch: true, presence: true }}
          showChannelSearch
          additionalChannelSearchProps={{ searchForChannels: true, placeholder: "Search conversations" }}
          customActiveChannel={deepLinkChannel}
          /* Mobile lands on the list; desktop still opens the most recent
             conversation on mount. A ?channel= deep link wins on both. */
          setActiveChannelOnMount={!isMobile || !!deepLinkChannel}
          EmptyStateIndicator={() => (
            <div className="p-6 text-center text-sm font-semibold text-[#68718f]">
              {readOnly
                ? "No conversations yet. Class group chats appear here once a provider starts one for a class you've booked."
                : "No conversations yet. Message a provider from a class page to start one."}
            </div>
          )}
        />
      </div>
      <div className={`min-w-0 flex-1 md:block ${chatOpen ? "block" : "hidden md:block"}`}>
        <Channel>
          <Window>
            <button
              type="button"
              onClick={() => setActiveChannel?.(undefined)}
              className="flex w-full items-center gap-2 border-b border-[#F4EFF0] px-4 py-3 text-sm font-bold text-[#34406f] hover:bg-[#FAF7F7] md:hidden"
            >
              <Icon name="chevron" className="h-4 w-4 rotate-180" /> All conversations
            </button>
            <ChannelHeader />
            <MessageList />
            {/* QA 04/09: "they should be able to see messages on classed booked
                onto but the type & send function be greyed out." Free parents
                get the reading half; the composer is replaced rather than
                disabled, so it explains itself instead of looking broken. */}
            {readOnly ? (
              <div className="border-t border-[#F4EFF0] bg-[#FAF7F7] px-4 py-3 text-sm font-semibold text-[#68718f]">
                Replying is a Plus feature.{" "}
                <a href="/pricing" className="font-black text-baby-pink hover:underline">
                  Upgrade to join in
                </a>
              </div>
            ) : (
              <MessageInput />
            )}
          </Window>
          <Thread />
        </Channel>
      </div>
    </div>
  );
}

/**
 * Every conversation a Plus parent is part of — provider enquiries, class
 * group chats, support — in one place. QA: "Where do parents paying see
 * messages? Need a tab". Mirrors the vendor portal's MessagesPage.
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
    <div className="bb-chat h-[600px] overflow-hidden rounded-[14px] border border-[#EBE3E5] bg-white shadow-card str-chat__theme-light">
      <Chat client={client}>
        <ChatPanes userId={userId} deepLinkChannel={deepLinkChannel} isMobile={isMobile} readOnly={readOnly} />
      </Chat>
    </div>
  );
}
