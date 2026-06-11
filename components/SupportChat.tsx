'use client';

import { useEffect, useState } from 'react';
import type { StreamChat as StreamChatType, Channel as ChannelType } from 'stream-chat';
import { StreamChat } from 'stream-chat';
import {
  Chat,
  Channel,
  Window,
  MessageList,
  MessageInput,
  ChannelHeader,
} from 'stream-chat-react';
import 'stream-chat-react/dist/css/v2/index.css';

export default function SupportChat() {
  const [client, setClient] = useState<StreamChatType | null>(null);
  const [channel, setChannel] = useState<ChannelType | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let chatClient: StreamChatType | null = null;

    (async () => {
      try {
        const res = await fetch('/api/chat/token');
        if (!res.ok) {
          setError(
            res.status === 401
              ? 'Please log in to chat with support.'
              : 'Could not start support chat. Please try again.'
          );
          return;
        }
        const { apiKey, token, channelId, userId, name } = await res.json();

        chatClient = StreamChat.getInstance(apiKey);
        await chatClient.connectUser({ id: userId, name }, token);
        const ch = chatClient.channel('messaging', channelId);
        await ch.watch();

        setClient(chatClient);
        setChannel(ch);
      } catch {
        setError('Could not start support chat. Please try again.');
      }
    })();

    return () => {
      chatClient?.disconnectUser();
    };
  }, []);

  if (error) return <p className="notice error">{error}</p>;
  if (!client || !channel) return <p className="muted">Connecting to support…</p>;

  return (
    <div className="chat-wrap">
      <Chat client={client}>
        <Channel channel={channel}>
          <Window>
            <ChannelHeader title="BabyBrain Support" />
            <MessageList />
            <MessageInput />
          </Window>
        </Channel>
      </Chat>
    </div>
  );
}
