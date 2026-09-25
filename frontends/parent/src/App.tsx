import { Suspense, useEffect, type ReactNode } from "react";
import { InstallBanner } from "./components/InstallBanner";
import { PullToRefresh } from "./components/PullToRefresh";
import { OfflinePage } from "./pages/OfflinePage";
import { useOnline } from "./lib/useOnline";
import { useAuth } from "./auth/AuthProvider";
import { AUTH_STORAGE_KEY } from "./lib/supabase";
import { useLocation, routePath } from "./lib/nav";
import { RainbowLoader } from "./components/RainbowLoader";
import { RouteErrorBoundary } from "./components/RouteErrorBoundary";
import { warmDashboard } from "./lib/prefetch";
import { lazyRoute } from "./lib/lazyRoute";
import AboutPage from "./pages/AboutPage";
import TermsPage from "./pages/TermsPage";
import PricingPage from "./pages/PricingPage";
import ContactPage from "./pages/ContactPage";

// Routes a first visit rarely lands on — each its own chunk, fetched when the
// route is first hit rather than shipped in the entry bundle. The static
// pages (About / Terms / Pricing / Contact) are a few kB each and built only
// from entry-bundle components, so they're imported eagerly at the top
// instead — a chunk apiece just bought a round-trip and a Suspense flash.
const BookedPage = lazyRoute(() => import("./pages/BookedPage"), "BookedPage");
const OnboardingPage = lazyRoute(() => import("./pages/OnboardingPage"), "OnboardingPage");

const ProfilePage = lazyRoute(() => import("./pages/dashboard").then((m) => ({ default: m.ProfilePage })), "ProfilePage");
const EditProfilePage = lazyRoute(() => import("./pages/dashboard").then((m) => ({ default: m.EditProfilePage })), "EditProfilePage");
const PaymentPage = lazyRoute(() => import("./pages/dashboard").then((m) => ({ default: m.PaymentPage })), "PaymentPage");
const BookingPage = lazyRoute(() => import("./pages/dashboard").then((m) => ({ default: m.BookingPage })), "BookingPage");
const LoginPage = lazyRoute(() => import("./pages/authPages").then((m) => ({ default: m.LoginPage })), "LoginPage");
const ForgotPasswordPage = lazyRoute(() => import("./pages/authPages").then((m) => ({ default: m.ForgotPasswordPage })), "ForgotPasswordPage");
const ResetPasswordPage = lazyRoute(() => import("./pages/authPages").then((m) => ({ default: m.ResetPasswordPage })), "ResetPasswordPage");

// The four pages below used to live inline in this file — together they were
// the bulk of a 1.7 MB (476 KB gzip) entry chunk that every route, including
// a hard refresh landing straight on /activity, had to download and parse
// before rendering anything. Each is now its own chunk, exactly like the
// pages above, fetched only when its route is actually hit.
const HomePage = lazyRoute(() => import("./pages/HomePage"), "HomePage");
const MatchesPage = lazyRoute(() => import("./pages/MatchesPage"), "MatchesPage");
const ExplorePage = lazyRoute(() => import("./pages/ExplorePage"), "ExplorePage");
const ActivityDetailPage = lazyRoute(() => import("./pages/ActivityDetailPage"), "ActivityDetailPage");

function hasStoredSession(): boolean {
  try {
    return localStorage.getItem(AUTH_STORAGE_KEY) != null;
  } catch {
    /* storage blocked — assume no session */
  }
  return false;
}

function App() {
  const online = useOnline();
  const { session, loading } = useAuth();
  // Re-render on client-side navigation (pushState via goTo, or back/forward).
  // The pages below read the URL during render, so they pick up the new route
  // as soon as App re-renders them.
  useLocation();
  // In production a Next rewrite serves these routes from `/`, but the Vite dev
  // server hosts the bundle under its `/app/` base — strip it so local routing
  // matches what parents actually browse.
  const pathname = routePath();

  // Once there's a session, warm the dashboard chunk on idle so Profile /
  // Bookings / Payment open without a fetch-and-skeleton. Gated on session so
  // a first-time visitor never downloads it, and deferred so it never
  // competes with the current route.
  useEffect(() => {
    if (!session) return;
    const ric = "requestIdleCallback" in window
      ? (window as unknown as { requestIdleCallback: (cb: () => void) => number }).requestIdleCallback
      : null;
    const id = ric ? ric(warmDashboard) : window.setTimeout(warmDashboard, 2000);
    return () => {
      if (ric) (window as unknown as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback?.(id);
      else window.clearTimeout(id);
    };
  }, [session]);

  const bootLoader = (
    <main data-bb-loading className="mx-auto max-w-[1180px] px-6 py-16">
      <RainbowLoader className="py-4" label="Loading" />
    </main>
  );

  let page: ReactNode;
  if (pathname === "/login") page = <LoginPage />;
  else if (pathname === "/forgot-password") page = <ForgotPasswordPage />;
  else if (pathname === "/reset-password") page = <ResetPasswordPage />;
  else if (pathname === "/pricing") page = <PricingPage />;
  else if (pathname === "/payment") page = <PaymentPage />;
  else if (pathname === "/book") page = <BookingPage />;
  else if (pathname === "/booked") page = <BookedPage />;
  else if (pathname === "/about") page = <AboutPage />;
  else if (pathname === "/onboarding") page = <OnboardingPage />;
  else if (pathname === "/matches") page = <MatchesPage />;
  else if (pathname === "/explore") page = <ExplorePage />;
  else if (pathname === "/activity") page = <ActivityDetailPage />;
  else if (pathname === "/profile") page = <ProfilePage />;
  else if (pathname === "/edit-profile") page = <EditProfilePage />;
  else if (pathname === "/contact") page = <ContactPage />;
  else if (pathname === "/terms") page = <TermsPage />;
  /* QA 01/09: Stripe's billing portal links out to a privacy policy, and a
     bare /privacy is the URL everyone expects (a `#privacy` fragment is also
     easy for an external service to drop). It has never been a route, so it
     fell through to the signed-in home. Same page, opened at that section. */
  else if (pathname === "/privacy") page = <TermsPage />;
  // Home: signed-in parents land on their personalised dashboard (matched
  // classes for their child), not the marketing page. While auth is still
  // resolving, a browser that has a stored session waits on a loader rather
  // than flashing the marketing landing page before the redirect.
  else if (!loading && session) page = <MatchesPage active="/" />;
  else if (loading && hasStoredSession()) page = bootLoader;
  else page = <HomePage />;

  // A lazily-loaded route's chunk still has to arrive; show the same boot
  // loader while it does. `data-bb-loading` keeps the index.html watchdog
  // treating a slow chunk as "still loading", not "wedged".
  //
  // The boundary catches a render fault or a chunk that fails to download
  // (a stale build after a redeploy) — without it either one unwinds past
  // React and leaves a blank screen with no way back but a manual reload,
  // which is what QA saw clicking Profile. Keyed by route so navigating
  // away clears a caught error.
  //
  // Offline takes over the whole screen ahead of everything else — a route
  // that's mid-fetch would otherwise sit on a spinner forever with no
  // explanation, and neither pull-to-refresh nor the install banner mean
  // anything without a network.
  if (!online) return <OfflinePage />;

  return (
    <>
      <RouteErrorBoundary key={pathname}>
        <Suspense fallback={bootLoader}>{page}</Suspense>
      </RouteErrorBoundary>
      <PullToRefresh />
      <InstallBanner pathname={pathname} />
    </>
  );
}

export default App;
