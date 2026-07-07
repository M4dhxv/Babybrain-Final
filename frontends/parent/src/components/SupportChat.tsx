import { useEffect, useState } from "react";
import type { Channel as StreamChannel, StreamChat } from "stream-chat";
import {
  Chat,
  Channel,
  Window,
  ChannelHeader,
  MessageList,
  MessageInput,
  Thread,
} from "stream-chat-react";
import "stream-chat-react/dist/css/v2/index.css";
import { getChatClient } from "../lib/chat";
import { apiGet } from "../lib/api";

/**
 * Modal that opens the logged-in parent's "BabyBrain Support" conversation and
 * renders the live GetStream thread. `/api/chat/token` provisions (idempotently)
 * the per-user support channel and returns its id. Mounted from the Contact
 * page's "message us" actions.
 */
export function SupportChat({ onClose }: { onClose: () => void }) {
  const [client, setClient] = useState<StreamChat | null>(null);
  const [channel, setChannel] = useState<StreamChannel | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const c = await getChatClient();
        const { channelId } = await apiGet<{ channelId: string }>("/api/chat/token");
        const ch = c.channel("messaging", channelId);
        await ch.watch();
        if (active) {
          setClient(c);
          setChannel(ch);
        }
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : "Could not start chat");
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="flex h-[600px] w-full max-w-2xl flex-col overflow-hidden rounded-[16px] bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[#eceff7] px-5 py-3">
          <div>
            <p className="text-sm font-bold text-baby-ink">Chat with BabyBrain Support</p>
            <p className="text-xs text-[#59658d]">We'll get back to you as soon as we can</p>
          </div>
          <button
            onClick={onClose}
            className="rounded-full px-3 py-1 text-sm font-bold text-[#59658d] hover:bg-[#f3f7ff]"
            aria-label="Close chat"
          >
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1">
          {error ? (
            <div className="flex h-full items-center justify-center p-6 text-center text-sm text-[#59658d]">{error}</div>
          ) : !client || !channel ? (
            <div className="flex h-full items-center justify-center text-sm text-[#59658d]">Connecting…</div>
          ) : (
            <Chat client={client}>
              <Channel channel={channel}>
                <Window>
                  <ChannelHeader />
                  <MessageList />
                  <MessageInput />
                </Window>
                <Thread />
              </Channel>
            </Chat>
          )}
        </div>
      </div>
    </div>
  );
}
