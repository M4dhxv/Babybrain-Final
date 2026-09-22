import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import { cacheFetch } from "./queryCache";

const FRESH_MS = 60_000;

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
    return () => {
      cancelled = true;
    };
  }, [userId]);

  return count;
}
