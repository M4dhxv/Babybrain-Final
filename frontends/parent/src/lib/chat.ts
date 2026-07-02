import { StreamChat } from "stream-chat";
import { apiGet } from "./api";

/**
 * Connects the logged-in parent to GetStream once and caches the client.
 * The token + apiKey come from `/api/vendor/chat/token` (a generic
 * mint-token-for-the-current-user route; works for parents and staff alike).
 */
let clientPromise: Promise<StreamChat> | null = null;

export function getChatClient(): Promise<StreamChat> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const { apiKey, token, userId } = await apiGet<{
        apiKey: string;
        token: string;
        userId: string;
      }>("/api/vendor/chat/token");
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
