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
