import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from './AuthProvider';

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
  if (!provider) return <Navigate to="/claim-business" replace />;
  return <Outlet />;
}
