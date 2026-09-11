import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AuthProvider } from "./auth/AuthProvider";
import { FavoritesProvider } from "./lib/favorites";
import { initPostHog } from "./lib/posthog";
import { installLinkInterception } from "./lib/nav";
import {
  RouteErrorBoundary,
  isChunkLoadError,
  reloadForChunkError,
  clearChunkReloadBudget,
  hadRouteError,
} from "./components/RouteErrorBoundary";
import "./styles/index.css";

// A stale chunk can also blow up outside React's render path — a dynamic
// import() in an event handler, a deferred prefetch, Vite's own preloader. The
// route boundary never sees those, so catch them here: a matching failure gets
// the same one-reload-then-stop treatment (the fresh index.html fixes it),
// anything else is left alone.
window.addEventListener("error", (e) => {
  if (isChunkLoadError(e.error) || isChunkLoadError({ message: e.message })) reloadForChunkError();
});
window.addEventListener("unhandledrejection", (e) => {
  if (isChunkLoadError(e.reason)) reloadForChunkError();
});
// Vite's own signal for a failed chunk preload; only swallow it when a reload is actually on its way.
window.addEventListener("vite:preloadError", (e) => {
  if (reloadForChunkError()) e.preventDefault();
});

// Signals the boot-splash watchdog in index.html. `__BB_BOOT_JS__` means the
// entry bundle executed (so a stale/failed asset is ruled out and it stops
// reloading); `__BB_BOOTED__` below means React actually rendered.
const bootWin = window as unknown as { __BB_BOOT_JS__?: boolean; __BB_BOOTED__?: boolean };
bootWin.__BB_BOOT_JS__ = true;

// Analytics is off the critical path — load posthog-js once the browser is
// idle (or shortly after) rather than competing with first paint.
const startAnalytics = () => void initPostHog();
if ("requestIdleCallback" in window) {
  (window as unknown as { requestIdleCallback: (cb: () => void) => void }).requestIdleCallback(startAnalytics);
} else {
  setTimeout(startAnalytics, 2000);
}

// Every internal link in this app is a plain `<a href="/x">` (see
// Button/CategoryTile in components/ui.tsx). This turns those into client-side
// navigations — no full-page reload, no bundle re-parse — for the routes App()
// renders; links to /auth/*, /vendor/*, external hosts, new tabs and downloads
// are left to the browser. In dev it also applies the `/app/` base the Vite
// server needs. See lib/nav.ts.
installLinkInterception();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {/* Outermost net: above the providers, so an error in AuthProvider /
        FavoritesProvider / the shared header is caught too and shows the
        recovery panel rather than a blank #root. The route-level boundary
        inside App handles per-page errors and lets you navigate away. */}
    <RouteErrorBoundary>
      <AuthProvider>
        <FavoritesProvider>
          <App />
        </FavoritesProvider>
      </AuthProvider>
    </RouteErrorBoundary>
  </React.StrictMode>,
);

bootWin.__BB_BOOTED__ = true;

// If the app has been up for a few seconds without a route boundary catching
// anything, the current build is fine — hand the stale-chunk reload budget
// back so a genuinely new failure later gets its own reloads. A reload loop
// (route throws on every mount) reloads well before this fires, so it can
// never reset its own rate limit.
setTimeout(() => {
  if (!hadRouteError()) clearChunkReloadBudget();
}, 6000);
