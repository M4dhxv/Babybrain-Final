import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AuthProvider } from "./auth/AuthProvider";
import { initPostHog } from "./lib/posthog";
import { goTo } from "./lib/nav";
import "./styles/index.css";

// Signals the boot-splash watchdog in index.html. `__BB_BOOT_JS__` means the
// entry bundle executed (so a stale/failed asset is ruled out and it stops
// reloading); `__BB_BOOTED__` below means React actually rendered.
const bootWin = window as unknown as { __BB_BOOT_JS__?: boolean; __BB_BOOTED__?: boolean };
bootWin.__BB_BOOT_JS__ = true;

initPostHog();

// This app has no client router — every internal link is a plain `<a href="/x">`
// (see Button/CategoryTile in components/ui.tsx). In production a Next rewrite
// serves these bare paths directly (next.config.mjs); the standalone Vite dev
// server only knows its `/app/` base, so a real browser navigation to `/x` 404s
// there. Intercept clicks on root-relative internal links in dev only and
// re-route them through the same `/app/` prefix `goTo()` already uses for
// programmatic redirects — production is untouched.
if (import.meta.env.DEV) {
  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = (e.target as HTMLElement)?.closest?.("a");
    if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
    const href = a.getAttribute("href");
    if (!href || !href.startsWith("/") || href.startsWith("//") || href.startsWith(import.meta.env.BASE_URL)) return;
    e.preventDefault();
    goTo(href);
  });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </React.StrictMode>,
);

bootWin.__BB_BOOTED__ = true;
