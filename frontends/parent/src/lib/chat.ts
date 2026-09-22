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
/** How often to resync the total from the server as a safety net, in case a
 *  websocket event that should move it (a message.new that never carries
 *  total_unread_count, an event type we don't handle, a dropped/reconnecting
 *  connection) gets missed — see the polling comment below. */
const RESYNC_MS = 10_000;
/** A mark-read on the server isn't always visible to a getUnreadCount() call
 *  fired the instant it happens — QA: the dot occasionally reappeared for a
 *  few seconds on a fresh page after reading, because our own resync landed
 *  before Stream's own read-state had actually committed. One quick follow-up
 *  a couple of seconds later closes that gap without waiting a full
 *  RESYNC_MS tick. */
const RESYNC_FOLLOWUP_MS = 2_500;

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
        let followUp: ReturnType<typeof setTimeout> | undefined;
        const resync = () =>
          client
            .getUnreadCount()
            .then((res) => {
              if (!cancelled) setUnread(res.total_unread_count);
            })
            .catch(() => {});
        // Fires resync() now and once more shortly after, to cover a
        // mark-read whose server-side write hasn't landed yet when the first
        // call goes out — see RESYNC_FOLLOWUP_MS.
        const resyncSoon = () => {
          resync();
          clearTimeout(followUp);
          followUp = setTimeout(resync, RESYNC_FOLLOWUP_MS);
        };
        // Same story as the event below: custom fields on the connected user
        // are loosely typed, so read the total defensively. This only exists
        // for an instant first paint on an already-connected client (the
        // getChatClient() promise was already resolved elsewhere) — it's NOT
        // kept in sync by Stream after mark-read/mark-unread calls, which was
        // the actual bug: reading a message cleared the dot on that page (the
        // event handler below caught it), but navigating to a fresh page
        // re-seeded from this same stale field and the dot came back until a
        // hard reload forced a brand new connectUser(). resyncSoon() right
        // after corrects it immediately instead of waiting for the next poll.
        const seed = (client.user as { total_unread_count?: unknown } | undefined)?.total_unread_count;
        setUnread(typeof seed === "number" ? seed : 0);
        resyncSoon();
        // Belt-and-braces on top of the event handler below: a websocket
        // reconnect (mobile app backgrounded, network blip) can resume with
        // events missed in between, which would otherwise leave the badge
        // stuck until something else happened to move it. Poll quietly, and
        // resync immediately when the tab/app comes back to the foreground —
        // the case this was actually reported for (QA: dot never appeared for
        // a message sent while the recipient's installed app was open).
        const interval = setInterval(resync, RESYNC_MS);
        const onVisible = () => {
          if (document.visibilityState === "visible") resyncSoon();
        };
        document.addEventListener("visibilitychange", onVisible);
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
        detach = () => {
          sub.unsubscribe();
          clearInterval(interval);
          clearTimeout(followUp);
          document.removeEventListener("visibilitychange", onVisible);
        };
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
