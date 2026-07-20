import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from './AuthProvider';
import NoBusinessGate from './NoBusinessGate';

/** Gate the vendor portal: must be signed in AND a member of a business. */
export default function RequireAuth() {
  const { session, provider, loading } = useAuth();
  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center text-gray-500">
        Loading…
      </div>
    );
  }
  if (!session) return <Navigate to="/login" replace />;
  // Signed in but no business linked. Could be a genuine not-yet-claimed vendor
  // OR a parent who wandered in (both apps share one session on this origin), so
  // offer a clear fork instead of silently dropping them into the claim form.
  if (!provider) return <NoBusinessGate />;
  return <Outlet />;
}
