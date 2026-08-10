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
} from "stream-chat-react";
import "stream-chat-react/dist/css/v2/index.css";
import { getChatClient } from "../lib/chat";

/**
 * Every conversation a Plus parent is part of — provider enquiries, class
 * group chats, support — in one place. QA: "Where do parents paying see
 * messages? Need a tab". Mirrors the vendor portal's MessagesPage.
 */
export function MessagesTab({ userId }: { userId: string }) {
  const [client, setClient] = useState<StreamChat | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deepLinkChannel] = useState(
    () => new URLSearchParams(window.location.search).get("channel") ?? undefined
  );

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
    return (
      <div className="rounded-[14px] border border-[#EBE3E5] bg-white p-10 text-center text-sm font-semibold text-[#68718f]">
        Connecting to messages…
      </div>
    );
  }

  return (
    <div className="h-[600px] overflow-hidden rounded-[14px] border border-[#EBE3E5] bg-white shadow-card str-chat__theme-light">
      <Chat client={client}>
        <div className="flex h-full">
          <div className="w-72 flex-shrink-0 overflow-y-auto border-r border-[#F4EFF0]">
            <ChannelList
              filters={{ type: "messaging", members: { $in: [userId] } }}
              sort={{ last_message_at: -1 }}
              options={{ state: true, watch: true, presence: true }}
              showChannelSearch
              additionalChannelSearchProps={{ searchForChannels: true, placeholder: "Search conversations" }}
              customActiveChannel={deepLinkChannel}
              EmptyStateIndicator={() => (
                <div className="p-6 text-center text-sm font-semibold text-[#68718f]">
                  No conversations yet. Message a provider from a class page to start one.
                </div>
              )}
            />
          </div>
          <div className="min-w-0 flex-1">
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
  );
}
