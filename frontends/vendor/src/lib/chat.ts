import { StreamChat } from 'stream-chat';
import { apiGet } from './api';

/**
 * Connects the logged-in vendor user to GetStream once and caches the
 * client. The token + apiKey come from `/api/vendor/chat/token` (server
 * mints them from the Stream secret). The vendor is a member of every
 * parent↔provider channel, so ChannelList filtered by membership shows
 * all their conversations.
 */
let clientPromise: Promise<StreamChat> | null = null;

export function getChatClient(): Promise<StreamChat> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const { apiKey, token, userId } = await apiGet<{
        apiKey: string;
        token: string;
        userId: string;
      }>('/api/vendor/chat/token');
      const client = StreamChat.getInstance(apiKey);
      if (!client.userID) {
        await client.connectUser({ id: userId }, token);
      }
      return client;
    })();
  }
  return clientPromise;
}

export async function disconnectChat(): Promise<void> {
  if (!clientPromise) return;
  const client = await clientPromise.catch(() => null);
  clientPromise = null;
  if (client) await client.disconnectUser();
}
