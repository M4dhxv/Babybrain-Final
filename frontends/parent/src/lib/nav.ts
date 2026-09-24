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

/**
 * Like scrollToWhenReady, but for a row inside a list where always aligning
 * to the top can walk the target half off-screen — a row near the bottom of
 * a long list, aligned to `block: "start"`, leaves the browser trying to put
 * a whole screen's worth of nothing beneath it, which either clips the row
 * against the page's real end or (with more content below) pushes it up
 * against a header. Picks the alignment from the row's position among its
 * rendered siblings instead: the first row aligns to the top (nothing above
 * it to waste space on), the last couple align to the bottom, everything
 * else centers — so the target always lands fully inside the viewport.
 *
 * Polls for up to 30s by default (a slow list load — e.g. My Bookings' own
 * multi-round-trip fetch — shouldn't outrun a 4-second window and land the
 * parent on an unscrolled page next to the row they came here to see, which
 * is exactly what a too-short poll looked like). `onFound` lets the caller
 * start a highlight animation timer from the moment the row actually
 * appears, not from when this was first called — otherwise a highlight
 * fired eagerly on a fixed timer can finish (and fade back to invisible)
 * before a slow-loading row ever exists to show it on.
 */
export function scrollHighlightIntoView(id: string, onFound?: () => void, tries = 150, everyMs = 200): () => void {
  let n = 0;
  const timer = window.setInterval(() => {
    const el = document.getElementById(id);
    if (el) {
      const siblings = el.parentElement ? Array.from(el.parentElement.children) : [el];
      const idx = siblings.indexOf(el);
      const block: ScrollLogicalPosition = idx <= 0 ? "start" : idx >= siblings.length - 2 ? "end" : "center";
      el.scrollIntoView({ behavior: "auto", block });
      window.clearInterval(timer);
      onFound?.();
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

const EXPLORE_RETURN_KEY = "bb:exploreReturn";

/** Remembers the last Explore URL (filters and all) a parent had open, so a
 *  "back to results" link from an activity page can return them to the same
 *  filtered view instead of a bare, unfiltered /explore. sessionStorage
 *  rather than the URL itself because the "back to results" link lives on a
 *  different page (/activity) than the state it needs to recall — a fresh
 *  tab starts clean, same as the filters themselves would. */
export function rememberExploreUrl(search: string) {
  try {
    sessionStorage.setItem(EXPLORE_RETURN_KEY, search);
  } catch {
    // Private browsing / storage disabled — the link just falls back to a
    // bare /explore, same as before this existed.
  }
}

/** Where "back to results" should go: the last remembered Explore URL
 *  (filters and all), or a bare /explore if none was recorded this session. */
export function exploreReturnHref(): string {
  try {
    const search = sessionStorage.getItem(EXPLORE_RETURN_KEY);
    return search ? `/explore${search}` : "/explore";
  } catch {
    return "/explore";
  }
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
const snapshot = () => window.location.pathname + window.location.search + window.location.hash;

/** Re-renders the caller whenever the route changes (pushState via `goTo`, or
 *  the browser back/forward buttons). App() calls this so its page switch is
 *  reactive; components that read the URL during render get the new value
 *  because App re-rendering re-renders them too. */
export function useLocation(): string {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
