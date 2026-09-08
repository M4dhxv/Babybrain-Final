/* Warm the signed-in dashboard chunk (Profile / Bookings / Payment / Booking) —
 * the biggest lazy route — so opening it from the header is instant rather than
 * a chunk fetch plus a skeleton. Called on idle once there's a session, and on
 * hover/focus of the account link. The module graph caches the import, so
 * repeat calls cost nothing after the first. A failed prefetch is swallowed and
 * un-latched so a later attempt (or the real navigation) retries; a genuine
 * stale-chunk failure at nav time is caught by RouteErrorBoundary. */
let warming = false;

export function warmDashboard(): void {
  if (warming) return;
  warming = true;
  import("../pages/dashboard").catch(() => {
    warming = false;
  });
}
