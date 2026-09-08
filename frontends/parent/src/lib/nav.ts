import { useSyncExternalStore } from "react";

/** In production a Next rewrite serves these routes from `/` (see
 *  next.config.mjs); the standalone Vite dev server only knows its `/app/`
 *  base, so dev needs the prefix — same split as the pathname-stripping in
 *  App() and the asset paths elsewhere. */
function prefixed(path: string) {
  const prefix = import.meta.env.DEV ? import.meta.env.BASE_URL : "/";
  return prefix + path.replace(/^\//, "");
}

/** The routes App() actually renders. A link to anything else — /auth/*,
 *  /vendor/*, /api/*, an external host — must be a real browser navigation,
 *  so the click interceptor and `goTo` leave those alone. Keep this in step
 *  with the switch in App(). */
const SPA_ROUTES = new Set([
  "/",
  "/login",
  "/forgot-password",
  "/reset-password",
  "/pricing",
  "/payment",
  "/book",
  "/booked",
  "/about",
  "/onboarding",
  "/matches",
  "/explore",
  "/activity",
  "/profile",
  "/edit-profile",
  "/contact",
  "/terms",
  "/privacy",
]);

/** Strip the dev `/app` base and any trailing slash. */
function normalisePath(pathname: string): string {
  return pathname.replace(/^\/app(?=\/|$)/, "").replace(/\/$/, "") || "/";
}

/** The current route, dev `/app` base and trailing slash stripped. The Vite
 *  dev server serves this SPA under /app/ while production rewrites it to the
 *  bare path, so anything branching on the route normalises both. */
export function routePath(): string {
  return normalisePath(window.location.pathname);
}

/** A `?name=` query param off the current URL, or null. */
export function getParam(name: string): string | null {
  return new URLSearchParams(window.location.search).get(name);
}

/**
 * Scroll to an element that may not exist yet. The browser resolves a hash
 * before the SPA has mounted and content often arrives a frame or two later
 * still, so a single delayed shot silently misses. Polls briefly, then gives
 * up quietly. Returns a cleanup for useEffect. Jumps rather than animates —
 * someone on a deep link hasn't scrolled anywhere, and `behavior:"smooth"` is
 * ignored in some environments.
 */
export function scrollToWhenReady(id: string, tries = 40, everyMs = 100): () => void {
  let n = 0;
  const timer = window.setInterval(() => {
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: "auto", block: "start" });
      window.clearInterval(timer);
    } else if (++n > tries) {
      window.clearInterval(timer);
    }
  }, everyMs);
  return () => window.clearInterval(timer);
}

/** Whether `pathOrUrl` is a route this SPA renders in place (so a link to it
 *  can be a pushState instead of a full reload). Anything non-relative, or a
 *  path outside the set, returns false. */
export function isSpaRoute(pathOrUrl: string): boolean {
  if (!pathOrUrl.startsWith("/") || pathOrUrl.startsWith("//")) return false;
  const path = pathOrUrl.split("?")[0].split("#")[0];
  return SPA_ROUTES.has(normalisePath(path));
}

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

if (typeof window !== "undefined") {
  window.addEventListener("popstate", emit);
}

/**
 * Navigate to an internal route.
 *
 * By default this is a client-side navigation: `history.pushState` + notify
 * `useLocation` subscribers, so App() re-renders the new page without the
 * browser tearing down and rebooting the whole bundle. Pass `{ hard: true }`
 * for the handful of transitions where a clean slate matters (sign-out,
 * post-login, account deletion) and for anything that isn't a known SPA route
 * (which falls back to a real navigation automatically).
 */
export function goTo(
  path: string,
  opts?: { hard?: boolean; replace?: boolean }
) {
  const url = prefixed(path);
  if (opts?.hard || !isSpaRoute(path)) {
    window.location.href = url;
    return;
  }
  if (opts?.replace) window.history.replaceState({}, "", url);
  else window.history.pushState({}, "", url);
  // A fresh page starts at the top; back/forward let the browser decide.
  window.scrollTo(0, 0);
  emit();
}

/** Absolute URL for a redirect target handed to something outside this page
 *  (a password-reset email link, an OAuth callback) — same prefix rule. */
export function appUrl(path: string) {
  return `${window.location.origin}${prefixed(path)}`;
}

/**
 * Turn plain internal `<a href="/x">` links into client-side navigations.
 * Every nav in this app is a bare anchor or a `goTo` call, so one delegated
 * listener covers the lot. Left-click only, no modifier keys, same-tab,
 * non-download, root-relative, and a known SPA route — otherwise the browser
 * handles it as normal.
 */
export function installLinkInterception() {
  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const anchor = (e.target as HTMLElement | null)?.closest?.("a");
    if (!anchor) return;
    if (anchor.target && anchor.target !== "_self") return;
    if (anchor.hasAttribute("download")) return;
    const href = anchor.getAttribute("href");
    if (!href || !isSpaRoute(href)) return;
    e.preventDefault();
    goTo(href);
  });
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};
const snapshot = () => window.location.pathname + window.location.search;

/** Re-renders the caller whenever the route changes (pushState via `goTo`, or
 *  the browser back/forward buttons). App() calls this so its page switch is
 *  reactive; components that read the URL during render get the new value
 *  because App re-rendering re-renders them too. */
export function useLocation(): string {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
