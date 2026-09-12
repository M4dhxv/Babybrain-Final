import { useEffect, useState } from "react";
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

/**
 * Total unread messages across every conversation this parent is in.
 *
 * QA 04/09: "when a parent has an unread message, it isn't clear — there
 * should be a notification on the messages tab i.e. a little 1, 2, 3 bubble."
 *
 * Stream stamps `total_unread_count` on `notification.message_new` /
 * `notification.mark_read` events, but NOT on `message.new` — and once a
 * channel has been watched (MessagesTab's ChannelList watches every
 * conversation, and Stream never un-watches them again on this connection),
 * every later message in it arrives as `message.new` with the field missing.
 * That's why the badge used to go stale until a full reload reconnected and
 * re-seeded it. For those events, ask Stream for the fresh total instead.
 * `enabled` is false for parents who can't use messaging at all (signed out,
 * or not on Plus) — connecting a chat client for them would be a wasted
 * round trip.
 */
export function useUnreadMessages(enabled: boolean): number {
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setUnread(0);
      return;
    }
    let cancelled = false;
    let detach: (() => void) | undefined;
    getChatClient()
      .then((client) => {
        if (cancelled) return;
        // Same story as the event below: custom fields on the connected user
        // are loosely typed, so read the total defensively.
        const seed = (client.user as { total_unread_count?: unknown } | undefined)?.total_unread_count;
        setUnread(typeof seed === "number" ? seed : 0);
        // One handler for every event that can move the total.
        const sub = client.on((e) => {
          // Stream's event type is a wide union; the running total rides on
          // the ones that move it, so read it defensively.
          const total = (e as { total_unread_count?: unknown }).total_unread_count;
          if (typeof total === "number") {
            setUnread(total);
            return;
          }
          // No total on this event (typically message.new on a watched
          // channel) but it can still move the count — skip our own
          // messages, which never do, and re-fetch for everyone else's.
          const senderId = (e as { user?: { id?: unknown } }).user?.id;
          if (e.type === "message.new" && senderId === client.userID) return;
          if (
            e.type === "message.new" ||
            e.type === "notification.added_to_channel" ||
            e.type === "notification.removed_from_channel" ||
            e.type === "channel.deleted" ||
            e.type === "notification.channel_deleted"
          ) {
            client
              .getUnreadCount()
              .then((res) => {
                if (!cancelled) setUnread(res.total_unread_count);
              })
              .catch(() => {});
          }
        });
        detach = () => sub.unsubscribe();
      })
      .catch(() => {
        // Chat being unavailable must never break the page it decorates.
      });
    return () => {
      cancelled = true;
      detach?.();
    };
  }, [enabled]);

  return unread;
}
