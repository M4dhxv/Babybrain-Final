import { StreamChat } from 'stream-chat';

/** Fixed Stream user the founders answer from (Stream Dashboard). */
export const SUPPORT_USER_ID = 'babybrain-support';

export const supportChannelId = (userId: string) => `support-${userId}`;

let serverClient: StreamChat | null = null;

/** Server-side Stream client (holds the API secret — never ship to browser). */
export function getStreamServerClient(): StreamChat {
  if (!serverClient) {
    serverClient = StreamChat.getInstance(
      process.env.NEXT_PUBLIC_STREAM_KEY!,
      process.env.STREAM_SECRET!
    );
  }
  return serverClient;
}
