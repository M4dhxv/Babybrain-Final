// Web Push worker for the parent site. Push only: no fetch handler, no caching
// (the app-shell cache lives in sw.js, scoped to /app/).
//
// It is registered with scope "/" (allowed by the Service-Worker-Allowed header
// next.config.mjs sets on this file) so a parent can subscribe from any page of
// the site, including the bare paths production serves the SPA from (/explore,
// /profile, ...), which sw.js's /app/ scope does not cover.
//
// The payload mirrors a `notifications` row (title/body/url), sent by
// app/api/webhooks/notifications via lib/push.ts.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: "BabyBrain", body: event.data ? event.data.text() : "" };
  }
  const { title = "BabyBrain", body = "", url = "/", tag, actions } = payload;
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      // Transparent mascot only (no square, no white backing) — see assets/brand/notify-icon.png.
      icon: "/app/assets/brand/notify-icon.png",
      // Android paints the badge from its alpha channel alone, so it must be a
      // transparent white silhouette; the full-colour app icon showed as a white square.
      badge: "/app/assets/brand/notify-badge.png",
      data: { url },
      // Ask to be noticed, like a message app: Android only promotes a web
      // notification to an on-screen banner when it signals it is important, and
      // a plain title+body one lands quietly in the tray.
      vibrate: [200, 100, 200],
      silent: false,
      timestamp: Date.now(),
      // One entry per conversation: a second message replaces the first and buzzes again.
      ...(tag ? { tag, renotify: true } : {}),
      // Where actions are supported (Chrome, Edge, Android) tapping one opens the same page.
      ...(Array.isArray(actions) && actions.length ? { actions: actions.slice(0, 2) } : {}),
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const existing = clients.find((c) => c.url === url);
      if (existing) return existing.focus();
      const sameOrigin = clients.find((c) => new URL(c.url).origin === self.location.origin);
      if (sameOrigin) return sameOrigin.focus().then(() => sameOrigin.navigate(url));
      return self.clients.openWindow(url);
    }),
  );
});
