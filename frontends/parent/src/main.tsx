import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AuthProvider } from "./auth/AuthProvider";
import { FavoritesProvider } from "./lib/favorites";
import { initPostHog } from "./lib/posthog";
import { installLinkInterception } from "./lib/nav";
import "./styles/index.css";

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
    <AuthProvider>
      <FavoritesProvider>
        <App />
      </FavoritesProvider>
    </AuthProvider>
  </React.StrictMode>,
);

bootWin.__BB_BOOTED__ = true;
