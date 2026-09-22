import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import { cacheFetch } from "./queryCache";

const FRESH_MS = 60_000;
/** Notifications have no realtime feed (unlike messages, which get one from
 *  Stream's websocket) — a new row only ever shows up here by asking again.
 *  Poll quietly, and resync right away when the tab/app comes back to the
 *  foreground, so a notification created while the parent had this open
 *  doesn't need a full page reload to show its dot. */
const RESYNC_MS = 20_000;

/** Unread notification count for the header's dot — a separate, lighter-weight
 *  cache entry from ProfilePage's own `profile:notifications:${uid}` fetch
 *  (which pulls full rows for the Notifications tab), so the two never fight
 *  over what shape is cached under the same key. ProfilePage invalidates this
 *  key too when it marks notifications read. */
export function useUnreadNotifications(userId: string | undefined): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!userId) {
      setCount(0);
      return;
    }
    let cancelled = false;
    const fetchCount = () =>
      supabase
        .from("notifications")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .is("read_at", null)
        .then(({ count }) => {
          if (!cancelled) setCount(count ?? 0);
        });
    // Fast first paint from cache (shared with anything else that just
    // fetched this), then poll the live count directly from here on.
    cacheFetch(`profile:unreadNotifications:${userId}`, FRESH_MS, () =>
      supabase
        .from("notifications")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .is("read_at", null)
        .then(({ count }) => count ?? 0)
    ).then((c) => {
      if (!cancelled) setCount(c);
    });
    const interval = setInterval(fetchCount, RESYNC_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") fetchCount();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [userId]);

  return count;
}
