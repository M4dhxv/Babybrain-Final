/** Hard (full-page) navigation to an app route, e.g. after login, after a
 *  search, or from a plain `<a>`/Button href. In production a Next rewrite
 *  serves these routes from `/` (see next.config.mjs); the standalone Vite
 *  dev server only knows its `/app/` base, so dev needs the prefix — same
 *  split as the pathname-stripping in App() and the asset paths elsewhere. */
function prefixed(path: string) {
  const prefix = import.meta.env.DEV ? import.meta.env.BASE_URL : "/";
  return prefix + path.replace(/^\//, "");
}

export function goTo(path: string) {
  window.location.href = prefixed(path);
}

/** Absolute URL for a redirect target handed to something outside this page
 *  (a password-reset email link, an OAuth callback) — same prefix rule. */
export function appUrl(path: string) {
  return `${window.location.origin}${prefixed(path)}`;
}
