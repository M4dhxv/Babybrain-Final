import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from './AuthProvider';
import NoBusinessGate from './NoBusinessGate';
import { RainbowLoader } from '@/components/ui/rainbow-loader';

/** Gate the vendor portal: must be signed in AND a member of a business. */
export default function RequireAuth() {
  const { session, provider, providerResolved, providerError, loading, refreshProvider } = useAuth();
  if (loading) {
    return (
      <div data-bb-loading className="flex h-screen items-center justify-center">
        <RainbowLoader label="Loading your portal" />
      </div>
    );
  }
  // No session (signed out, or the refresh token expired while the tab sat
  // open): send them to the public landing page rather than a bare login form.
  if (!session) return <Navigate to="/" replace />;

  // Signed in, but we don't yet know whether this account has a business. The
  // lookup can lose a race with the token refresh on a cold page load, and
  // reading that silence as "no business" is what put real vendors on the
  // chooser below after a refresh. Wait for a real answer instead.
  if (!provider && !providerResolved && !providerError) {
    return (
      <div data-bb-loading className="flex h-screen items-center justify-center">
        <RainbowLoader label="Loading your portal" />
      </div>
    );
  }

  // The lookup failed outright (offline, RLS hiccup). Say so and offer a retry
  // — claiming "no business" here would be a guess, and a misleading one.
  if (!provider && providerError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
        <div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-8 text-center shadow-sm">
          <h1 className="mb-1 text-xl font-bold text-gray-900">We couldn&rsquo;t load your business</h1>
          <p className="mb-6 text-sm text-gray-500">
            Your sign-in is fine — the connection dropped while we were fetching it.
          </p>
          <button
            onClick={() => { void refreshProvider(); }}
            className="rounded-xl bg-gradient-to-r from-[#FA4D8D] to-[#FF6B9B] px-6 py-2.5 text-sm font-semibold text-white hover:brightness-105"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  // Genuinely no business linked. Could be a not-yet-claimed vendor OR a parent
  // who wandered in (both apps share one session on this origin), so offer a
  // clear fork instead of silently dropping them into the claim form.
  if (!provider) return <NoBusinessGate />;
  return <Outlet />;
}
