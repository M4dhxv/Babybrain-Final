import { useEffect, useState } from "react";

/**
 * `navigator.onLine` plus the `online`/`offline` events — true whenever the
 * browser believes it has a network path at all. It's a coarse signal (a
 * captive portal or a dead upstream link can still report `true`), which is
 * why OfflinePage's "Try again" does a real fetch probe rather than trusting
 * this alone to decide it can dismiss.
 */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  return online;
}
