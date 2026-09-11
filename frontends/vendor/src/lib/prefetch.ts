/**
 * Warm a route's lazy chunk before the vendor actually navigates to it, so the
 * common tab-to-tab hops don't flash the <RouteFallback> rainbow while a chunk
 * downloads.
 *
 * The dynamic `import()` expressions here are the same ones App.tsx passes to
 * `lazyRoute()`, so the bundler emits one chunk per page and the module graph caches
 * it — a prefetch plus the real navigation cost exactly one download between
 * them, in whichever order they happen. A failed prefetch is swallowed and
 * un-latched so the real navigation (or a later hover) retries; a genuine
 * stale-chunk failure at navigation time is still caught by RouteErrorBoundary.
 */

const thunks: Record<string, () => Promise<unknown>> = {
  '/': () => import('../pages/LandingPage'),
  '/plans': () => import('../pages/PlansPage'),
  '/login': () => import('../pages/LoginPage'),
  '/claim-business': () => import('../pages/ClaimBusinessPage'),
  '/contact': () => import('../pages/ContactPage'),
  '/about': () => import('../pages/AboutPage'),
  '/terms': () => import('../pages/TermsPage'),
  '/dashboard': () => import('../pages/DashboardPage'),
  '/activities': () => import('../pages/ActivitiesPage'),
  '/schedule': () => import('../pages/SchedulePage'),
  '/bookings': () => import('../pages/BookingsPage'),
  '/packages': () => import('../pages/PackagesPage'),
  '/make-up-tokens': () => import('../pages/MakeUpTokensPage'),
  '/messages': () => import('../pages/MessagesPage'),
  '/notifications': () => import('../pages/NotificationsPage'),
  '/insights': () => import('../pages/InsightsPage'),
  '/reviews': () => import('../pages/ReviewsPage'),
  '/settings': () => import('../pages/SettingsPage'),
  '/billing': () => import('../pages/BillingPage'),
  '/earnings': () => import('../pages/EarningsPage'),
};

const started = new Set<string>();

/** Kick off the chunk download for `path` if we haven't already. Safe to call
 *  on every hover/focus — it latches per path. */
export function prefetchRoute(path: string): void {
  if (started.has(path)) return;
  const thunk = thunks[path];
  if (!thunk) return;
  started.add(path);
  Promise.resolve()
    .then(thunk)
    .catch(() => {
      started.delete(path);
    });
}

/** Warm the three hot portal tabs once the browser is idle after sign-in. */
export function warmPortal(): void {
  const warm = () => ['/dashboard', '/schedule', '/bookings'].forEach(prefetchRoute);
  const w = window as unknown as { requestIdleCallback?: (cb: () => void) => void };
  if (typeof w.requestIdleCallback === 'function') w.requestIdleCallback(warm);
  else setTimeout(warm, 1500);
}
