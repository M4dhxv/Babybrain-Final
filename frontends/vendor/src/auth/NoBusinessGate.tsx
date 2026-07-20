import { useNavigate } from 'react-router-dom';
import { Store, ArrowRight, Baby, LogOut } from 'lucide-react';
import { useAuth } from './AuthProvider';

/**
 * Shown when someone is signed in but their account isn't linked to a business.
 *
 * The parent site and the vendor portal are the same origin and share one
 * Supabase session, so a logged-in PARENT who opens `/vendor` lands here too —
 * not just a genuine not-yet-claimed vendor. We can't tell the two apart from
 * data (both have no provider), so instead of silently funnelling everyone into
 * the business-claim form we present a clear fork: claim a business, or head
 * back to the consumer site. "Back to BabyBrain" leaves the vendor SPA entirely
 * (`/vendor/`) for the parent app at the origin root.
 */
export default function NoBusinessGate() {
  const navigate = useNavigate();
  const { session, signOut } = useAuth();
  const email = session?.user.email ?? '';

  async function handleSignOut() {
    await signOut();
    navigate('/login');
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
        <div className="mb-6 flex items-center gap-2">
          <img
            src={`${import.meta.env.BASE_URL}assets/logo-icon.png`}
            alt="BabyBrain"
            className="h-8 w-8 rounded-full"
          />
          <div>
            <div className="text-lg font-bold text-[#E91E63]">BabyBrain</div>
            <div className="text-xs text-gray-500">Vendor Portal</div>
          </div>
        </div>

        <h1 className="mb-1 text-xl font-bold text-gray-900">This account isn&rsquo;t linked to a business</h1>
        <p className="mb-6 text-sm text-gray-500">
          {email ? <>You&rsquo;re signed in as <span className="font-semibold text-gray-700">{email}</span>. </> : null}
          Choose where you&rsquo;d like to go.
        </p>

        <div className="space-y-3">
          {/* Genuine vendor: claim / set up their business */}
          <button
            onClick={() => navigate('/claim-business')}
            className="flex w-full items-center gap-4 rounded-xl border border-gray-200 p-4 text-left transition-shadow hover:shadow-card-hover"
          >
            <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl bg-pink-100">
              <Store className="h-5 w-5 text-[#E91E63]" />
            </div>
            <div className="flex-1">
              <div className="font-semibold text-gray-900">I run a business</div>
              <div className="text-xs text-gray-500">Claim or set up your listing on BabyBrain.</div>
            </div>
            <ArrowRight className="h-5 w-5 text-gray-400" />
          </button>

          {/* Parent who wandered in: escape to the consumer site */}
          <a
            href="/"
            className="flex w-full items-center gap-4 rounded-xl border border-gray-200 p-4 text-left transition-shadow hover:shadow-card-hover"
          >
            <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl bg-blue-100">
              <Baby className="h-5 w-5 text-blue-600" />
            </div>
            <div className="flex-1">
              <div className="font-semibold text-gray-900">I&rsquo;m looking for activities for my child</div>
              <div className="text-xs text-gray-500">Go back to BabyBrain to browse and book.</div>
            </div>
            <ArrowRight className="h-5 w-5 text-gray-400" />
          </a>
        </div>

        <button
          onClick={handleSignOut}
          className="mt-6 flex w-full items-center justify-center gap-2 text-sm font-semibold text-gray-500 hover:text-gray-700"
        >
          <LogOut className="h-4 w-4" />
          Sign out
        </button>
      </div>
    </div>
  );
}
