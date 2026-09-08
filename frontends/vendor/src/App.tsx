import { lazy, Suspense, useEffect } from 'react';
import { HashRouter, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthProvider';
import { capturePageview } from './lib/posthog';
import RequireAuth from './auth/RequireAuth';
import PortalLayout from './layouts/PortalLayout';
import { RainbowLoader } from '@/components/ui/rainbow-loader';
import { RouteErrorBoundary } from '@/components/RouteErrorBoundary';

// Every page is its own chunk, fetched when its route is first visited, so a
// first load (or a hard reload) no longer ships all ~25 pages — plus recharts,
// stream-chat and the whole Radix set — in one bundle.
const LandingPage = lazy(() => import('./pages/LandingPage'));
const PlansPage = lazy(() => import('./pages/PlansPage'));
const ClaimBusinessPage = lazy(() => import('./pages/ClaimBusinessPage'));
const ContactPage = lazy(() => import('./pages/ContactPage'));
const AboutPage = lazy(() => import('./pages/AboutPage'));
const TermsPage = lazy(() => import('./pages/TermsPage'));
const SaveListingPage = lazy(() => import('./pages/SaveListingPage'));
const LoginPage = lazy(() => import('./pages/LoginPage'));
const ForgotPasswordPage = lazy(() => import('./pages/ForgotPasswordPage'));
const ResetPasswordPage = lazy(() => import('./pages/ResetPasswordPage'));
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const ActivitiesPage = lazy(() => import('./pages/ActivitiesPage'));
const SchedulePage = lazy(() => import('./pages/SchedulePage'));
const BookingsPage = lazy(() => import('./pages/BookingsPage'));
const PackagesPage = lazy(() => import('./pages/PackagesPage'));
const MakeUpTokensPage = lazy(() => import('./pages/MakeUpTokensPage'));
const InsightsPage = lazy(() => import('@/pages/InsightsPage'));
const MessagesPage = lazy(() => import('./pages/MessagesPage'));
const NotificationsPage = lazy(() => import('./pages/NotificationsPage'));
const ReviewsPage = lazy(() => import('./pages/ReviewsPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const BillingPage = lazy(() => import('./pages/BillingPage'));
const EarningsPage = lazy(() => import('./pages/EarningsPage'));
const NotFoundPage = lazy(() => import('./pages/NotFoundPage'));

/**
 * When Supabase parses a password-reset link it fires PASSWORD_RECOVERY. Because
 * we use HashRouter, the recovery lands on the app root — this sends the user to
 * the reset form. Lives inside the router so it can navigate.
 */
function RecoveryRedirect() {
  const { recovery } = useAuth();
  const navigate = useNavigate();
  useEffect(() => {
    if (recovery) navigate('/reset-password');
  }, [recovery, navigate]);
  return null;
}

/** Captures a PostHog $pageview on every route change (HashRouter SPA). */
function PageviewTracker() {
  const location = useLocation();
  useEffect(() => {
    capturePageview();
  }, [location.pathname]);
  return null;
}

/** Reset the scroll position on navigation.
 *
 *  A router swap replaces the content but leaves the window where it was, so
 *  following a footer link left you at the bottom of the new page. QA read that
 *  as the links themselves being broken: "the 'Why BabyBrain', 'Plans &
 *  Pricing', 'Claim Your Business' and 'Contact Us' tabs all direct to the
 *  bottom of the page". The routes were right all along. */
function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior });
  }, [pathname]);
  return null;
}

/** Shown while a route's chunk is in flight. `data-bb-loading` keeps the
 *  index.html watchdog treating a slow chunk as "loading", not "wedged". */
function RouteFallback() {
  return (
    <div data-bb-loading className="flex h-screen items-center justify-center">
      <RainbowLoader label="Loading" />
    </div>
  );
}

function App() {
  return (
    <AuthProvider>
      <HashRouter>
        <RecoveryRedirect />
        <ScrollToTop />
        <PageviewTracker />
        {/* Net around every routed page: a lazy chunk that fails to download
            after a redeploy, or a render fault, shows a Reload panel instead of
            an empty #root. Unkeyed so it never remounts the tree on a plain
            navigation; portal pages get a second, route-keyed boundary inside
            PortalLayout so recovering is as easy as switching tabs. */}
        <RouteErrorBoundary>
        <Suspense fallback={<RouteFallback />}>
          <Routes>
            {/* Public pages */}
            <Route path="/" element={<LandingPage />} />
            <Route path="/plans" element={<PlansPage />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/forgot-password" element={<ForgotPasswordPage />} />
            <Route path="/reset-password" element={<ResetPasswordPage />} />
            <Route path="/claim-business" element={<ClaimBusinessPage />} />
            <Route path="/contact" element={<ContactPage />} />
            <Route path="/about" element={<AboutPage />} />
            <Route path="/terms" element={<TermsPage />} />
            <Route path="/save-listing" element={<SaveListingPage />} />

            {/* Vendor Portal — auth-gated, with sidebar layout */}
            <Route element={<RequireAuth />}>
              <Route element={<PortalLayout />}>
                <Route path="/dashboard" element={<DashboardPage />} />
                <Route path="/activities" element={<ActivitiesPage />} />
                <Route path="/schedule" element={<SchedulePage />} />
                {/* Wix Availability was folded into Schedule — old links/bookmarks still land somewhere. */}
                <Route path="/wix-availability" element={<Navigate to="/schedule" replace />} />
                <Route path="/bookings" element={<BookingsPage />} />
                <Route path="/packages" element={<PackagesPage />} />
                <Route path="/make-up-tokens" element={<MakeUpTokensPage />} />
                <Route path="/messages" element={<MessagesPage />} />
                <Route path="/notifications" element={<NotificationsPage />} />
                <Route path="/insights" element={<InsightsPage />} />
                <Route path="/reviews" element={<ReviewsPage />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="/billing" element={<BillingPage />} />
                <Route path="/earnings" element={<EarningsPage />} />
              </Route>
            </Route>

            {/* Branded 404 — also reachable directly at #/404 */}
            <Route path="/404" element={<NotFoundPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </Suspense>
        </RouteErrorBoundary>
      </HashRouter>
    </AuthProvider>
  );
}

export default App;
