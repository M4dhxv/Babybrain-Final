import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './auth/AuthProvider';
import RequireAuth from './auth/RequireAuth';
import LandingPage from './pages/LandingPage';
import PlansPage from './pages/PlansPage';
import ClaimBusinessPage from './pages/ClaimBusinessPage';
import SaveListingPage from './pages/SaveListingPage';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import ActivitiesPage from './pages/ActivitiesPage';
import BookingsPage from './pages/BookingsPage';
import SettingsPage from './pages/SettingsPage';
import BillingPage from './pages/BillingPage';
import PortalLayout from './layouts/PortalLayout';

function App() {
  return (
    <AuthProvider>
      <HashRouter>
        <Routes>
          {/* Public pages */}
          <Route path="/" element={<LandingPage />} />
          <Route path="/plans" element={<PlansPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/claim-business" element={<ClaimBusinessPage />} />
          <Route path="/save-listing" element={<SaveListingPage />} />

          {/* Vendor Portal — auth-gated, with sidebar layout */}
          <Route element={<RequireAuth />}>
            <Route element={<PortalLayout />}>
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/activities" element={<ActivitiesPage />} />
              <Route path="/bookings" element={<BookingsPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/billing" element={<BillingPage />} />
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
