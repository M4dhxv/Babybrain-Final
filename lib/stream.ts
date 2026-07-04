import { createHash } from 'crypto';
import { StreamChat } from 'stream-chat';

/** Fixed Stream user the founders answer from (Stream Dashboard). */
export const SUPPORT_USER_ID = 'babybrain-support';

export const supportChannelId = (userId: string) => `support-${userId}`;

/**
 * Deterministic, collision-resistant channel suffix. Truncating raw UUIDs
 * (the old `slice(0, 8)`) risked two distinct pairs/classes mapping to the
 * same channel — a chat-confidentiality leak. A SHA-256 of the full inputs
 * keeps ids stable + idempotent without the truncation birthday risk. Stream
 * channel ids must be <=64 chars and [a-zA-Z0-9_-] only, so we keep it short.
 */
const channelHash = (...parts: string[]): string =>
  createHash('sha256').update(parts.join(':')).digest('hex').slice(0, 32);

/** Parent ↔ provider channel id. Deterministic so it's idempotent. */
export const providerChannelId = (providerId: string, parentId: string) =>
  `pp-${channelHash(providerId, parentId)}`;

/** Group chat id for a class (activity). Deterministic + idempotent. */
export const classChannelId = (activityId: string) => `class-${channelHash(activityId)}`;

/** Stream "team"/member id for a provider (so all staff share the channel). */
export const providerTeamUserId = (providerId: string) => `provider-${providerId}`;

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
