import { useEffect } from 'react';
import { HashRouter, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthProvider';
import { capturePageview } from './lib/posthog';
import RequireAuth from './auth/RequireAuth';
import LandingPage from './pages/LandingPage';
import PlansPage from './pages/PlansPage';
import ClaimBusinessPage from './pages/ClaimBusinessPage';
import ContactPage from './pages/ContactPage';
import SaveListingPage from './pages/SaveListingPage';
import LoginPage from './pages/LoginPage';
import ForgotPasswordPage from './pages/ForgotPasswordPage';
import ResetPasswordPage from './pages/ResetPasswordPage';
import DashboardPage from './pages/DashboardPage';
import ActivitiesPage from './pages/ActivitiesPage';
import SchedulePage from './pages/SchedulePage';
import BookingsPage from './pages/BookingsPage';
import PackagesPage from './pages/PackagesPage';
import MakeUpTokensPage from './pages/MakeUpTokensPage';
import InsightsPage from '@/pages/InsightsPage';
import MessagesPage from './pages/MessagesPage';
import NotificationsPage from './pages/NotificationsPage';
import ReviewsPage from './pages/ReviewsPage';
import SettingsPage from './pages/SettingsPage';
import BillingPage from './pages/BillingPage';
import EarningsPage from './pages/EarningsPage';
import PortalLayout from './layouts/PortalLayout';

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

function App() {
  return (
    <AuthProvider>
      <HashRouter>
        <RecoveryRedirect />
        <ScrollToTop />
        <PageviewTracker />
        <Routes>
          {/* Public pages */}
          <Route path="/" element={<LandingPage />} />
          <Route path="/plans" element={<PlansPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="/claim-business" element={<ClaimBusinessPage />} />
          <Route path="/contact" element={<ContactPage />} />
          <Route path="/save-listing" element={<SaveListingPage />} />

          {/* Vendor Portal — auth-gated, with sidebar layout */}
          <Route element={<RequireAuth />}>
            <Route element={<PortalLayout />}>
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/activities" element={<ActivitiesPage />} />
              <Route path="/schedule" element={<SchedulePage />} />
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

          {/* Fallback */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </HashRouter>
    </AuthProvider>
  );
}

export default App;
