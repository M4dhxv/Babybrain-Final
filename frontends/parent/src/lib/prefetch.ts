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

let warmingExplore = false;

/** Warm the Explore page (and its map) so opening it from the nav is instant. Safe to call repeatedly. */
export function warmExplore(): void {
  if (warmingExplore) return;
  warmingExplore = true;
  Promise.all([import("../pages/ExplorePage"), import("../components/ExploreMap")]).catch(() => {
    warmingExplore = false;
  });
}

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

let warmingActivity = false;

/** Warm the activity page's chunk so the first listing opened isn't a chunk fetch + skeleton. */
export function warmActivity(): void {
  if (warmingActivity) return;
  warmingActivity = true;
  import("../pages/ActivityDetailPage").catch(() => {
    warmingActivity = false;
  });
}

/**
 * Start an activity page's data requests the moment a parent shows intent —
 * pointer over a card (desktop), finger down on it (phone), keyboard focus — so
 * the listing and its live availability are usually already in flight (or
 * landed) by the time the page mounts. One delegated listener covers every card
 * on Home, Matches and Explore. See `prefetchActivity` in lib/data.ts.
 */
export function installActivityPrefetch(): void {
  const seen = new Set<string>();
  const onIntent = (e: Event) => {
    const a = (e.target as HTMLElement | null)?.closest?.("a");
    const href = a?.getAttribute("href");
    if (!href || !/^\/(app\/)?activity\?/.test(href)) return;
    const slug = new URLSearchParams(href.split("?")[1]).get("slug");
    if (!slug || seen.has(slug)) return;
    seen.add(slug);
    warmActivity();
    void import("./data").then((m) => m.prefetchActivity(slug));
    // Allow a later re-prefetch (the shared cache decides if it's still fresh).
    window.setTimeout(() => seen.delete(slug), 30_000);
  };
  document.addEventListener("pointerover", onIntent, { passive: true });
  document.addEventListener("touchstart", onIntent, { passive: true });
  document.addEventListener("focusin", onIntent);
}
