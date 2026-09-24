// App-shell cache for the parent PWA.
//
// The point isn't "work offline" — it's that an installed Android app shows
// its own native splash screen (drawn from manifest.webmanifest, before any
// of our JS runs) while it fetches this page over the network. Without a
// cache, that native splash lingers for a full round-trip on every launch.
// With one, a repeat launch serves the shell straight from disk and our own
// confetti/icon/name splash (index.html) takes over almost immediately.
//
// Hashed build assets under /app/assets/ are content-fingerprinted by Vite —
// the same URL can never point at different content, so caching them
// cache-first forever is safe: a new deploy ships new filenames, not new
// bytes under an old one. The HTML document itself is the opposite case —
// it's the one thing that must always reflect the latest deploy — so it's
// network-first, with the cached copy only used as an offline fallback.
//
// Bump CACHE when this file's own strategy changes (not on every app
// deploy — the hashed-asset cache-first rule handles that automatically).
const CACHE = "bb-shell-v1";
const SHELL_URLS = [
  "/app/",
  "/app/manifest.webmanifest",
  "/app/assets/brand/icon-192.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL_URLS))
      .catch(() => {}), // offline install / a shell URL 404ing shouldn't block activation
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() => caches.match("/app/").then((hit) => hit || caches.match(request))),
    );
    return;
  }

  if (url.pathname.startsWith("/app/assets/")) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((res) => {
            if (res.ok) caches.open(CACHE).then((cache) => cache.put(request, res.clone()));
            return res;
          }),
      ),
    );
  }
});

// Web Push only ever reaches an installed app (lib/push.ts gates the
// subscribe prompt on isStandalone()) — the payload mirrors a `notifications`
// row (title/body/url) sent by app/api/webhooks/notifications.
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: "BabyBrain", body: event.data ? event.data.text() : "" };
  }
  const { title = "BabyBrain", body = "", url = "/app/" } = payload;
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/app/assets/brand/icon-192.png",
      badge: "/app/assets/brand/icon-192.png",
      data: { url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/app/", self.location.origin).href;
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
