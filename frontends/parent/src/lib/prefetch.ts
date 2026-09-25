/* Warm the signed-in parent's own pages (Profile / Bookings, EditProfile,
 * Payment, Booking — each its own chunk since they were split out of one
 * shared "dashboard" bundle) so opening any of them from the header, a
 * notification, or an activity's "Book" button is instant rather than a
 * chunk fetch plus a skeleton. Called on idle once there's a session, and on
 * hover/focus of the account link. The module graph caches each import, so
 * repeat calls cost nothing after the first. A failed prefetch is swallowed
 * and un-latched so a later attempt (or the real navigation) retries; a
 * genuine stale-chunk failure at nav time is caught by RouteErrorBoundary. */
let warming = false;

export function warmDashboard(): void {
  if (warming) return;
  warming = true;
  Promise.all([
    import("../pages/ProfilePage"),
    import("../pages/EditProfilePage"),
    import("../pages/PaymentPage"),
    import("../pages/BookingPage"),
  ]).catch(() => {
    warming = false;
  });
}
