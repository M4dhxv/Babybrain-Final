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
  const { title = "BabyBrain", body = "", url = "/", tag, actions, icon, image } = payload;
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      // A booking confirmation or suggestion brings the class's own photo (fitted server-side by
      // /api/push/image, so a vendor's logo is never cropped); everything else keeps the mascot.
      // Transparent mascot only (no square, no white backing) — see assets/brand/notify-icon.png.
      icon: typeof icon === "string" && icon ? icon : "/app/assets/brand/notify-icon.png",
      // The large picture under the text when expanded (Android/Chrome; iOS ignores it).
      ...(typeof image === "string" && image ? { image } : {}),
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
  let target = new URL(event.notification.data?.url || "/", self.location.origin);
  // A page on this site only, whatever the payload says.
  if (target.origin !== self.location.origin) target = new URL("/", self.location.origin);
  const url = target.href;
  // The parent site and the vendor portal share this worker; open a vendor
  // notification in a portal window and a parent one in a parent window.
  const isPortal = (u) => new URL(u).pathname.startsWith("/vendor");
  const wantPortal = isPortal(url);
  event.waitUntil(
    (async () => {
      const windows = (await self.clients.matchAll({ type: "window", includeUncontrolled: true }))
        .filter((c) => new URL(c.url).origin === self.location.origin);
      const exact = windows.find((c) => c.url === url);
      if (exact) return exact.focus();
      const win = windows.find((c) => isPortal(c.url) === wantPortal);
      if (!win) return self.clients.openWindow(url);
      const focused = (await win.focus().catch(() => null)) || win;
      // navigate() only works on a window this worker controls. The installed
      // parent app runs under sw.js (scope /app/), where it throws and the tap
      // used to only bring the app forward; there the page opens it itself
      // (installPushNavigation in src/lib/nav.ts).
      try {
        const done = await focused.navigate(url);
        if (done) return done;
      } catch {
        /* not controlled by this worker */
      }
      focused.postMessage({ type: "bb:navigate", url: target.pathname + target.search + target.hash });
      return focused;
    })(),
  );
});
