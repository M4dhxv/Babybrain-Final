import { useEffect, useRef, useState } from 'react';
import { supabase } from './supabase';

const POLL_MS = 60_000;

/**
 * Unread-count bubble on the Notifications nav item — same idea as
 * useUnreadMessages for the Messages tab (chat.ts), but the source is
 * provider_notification_unread_count (00139) rather than a Stream push
 * event, since the notification feed itself (provider_notification_feed,
 * 00041) is a stateless re-derived list with nothing to subscribe to.
 *
 * No realtime channel here — this polls on an interval and on tab/window
 * focus, plus whenever `refreshKey` changes (PortalLayout passes the route
 * pathname, so navigating anywhere re-checks — in particular navigating
 * *away* from /notifications picks up markNotificationsSeen's reset without
 * waiting out the poll interval).
 */
export function useUnreadNotifications(providerId: string | null, refreshKey?: unknown): number {
  const [count, setCount] = useState(0);
  // Avoids setting state after the provider changes out from under an
  // in-flight request (fetches don't cancel themselves).
  const requestId = useRef(0);

  useEffect(() => {
    if (!providerId) {
      setCount(0);
      return;
    }
    const id = ++requestId.current;

    const load = async () => {
      const { data, error } = await supabase.rpc('provider_notification_unread_count', { p_provider: providerId });
      if (id !== requestId.current) return;
      if (!error && typeof data === 'number') setCount(data);
    };

    load();
    const interval = window.setInterval(load, POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    window.addEventListener('focus', load);
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', load);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [providerId, refreshKey]);

  return count;
}

/** Marks the feed "seen as of now" for this vendor — call once when the
 *  Notifications tab mounts. Fire-and-forget: a failed mark just means the
 *  badge doesn't clear until the next successful one, never a blocked page. */
export function markNotificationsSeen(providerId: string): void {
  supabase.rpc('mark_provider_notifications_seen', { p_provider: providerId }).then(({ error }) => {
    if (error) console.error('mark_provider_notifications_seen failed', error);
  });
}
