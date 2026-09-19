import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import { CheckCircle2, Loader2, Shield, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { apiPost } from '@/lib/api';
import { useAuth } from '@/auth/AuthProvider';

const TERMS_URL = `${window.location.origin}${import.meta.env.BASE_URL}#/terms`;
const PRIVACY_URL = `${TERMS_URL}#privacy`;
const TOU_URL = `${TERMS_URL}#tou`;

function connectSkippedKey(providerId: string) {
  return `bb_connect_skipped_${providerId}`;
}

/**
 * First-run gate for a freshly invited owner: accept Terms & Privacy, then a
 * Stripe Connect prompt. Sits in RequireAuth, in place of the portal, so it
 * runs before anything else — including a staff-invite-style sign-in link,
 * which (unlike Claim Your Business) never asked for consent.
 *
 * Terms is blocking — the "Agree & continue" button is disabled until both
 * boxes are checked, same bar as Claim Your Business. Stripe Connect is a
 * prompt, not a lock: publishing a paid activity without payouts connected
 * is its own separate admin-side gate (lib/admin-update-provider.ts), so this
 * screen doesn't need to be one too. "Skip for now" lets an owner into the
 * portal immediately, and the choice is remembered per browser — every
 * subsequent full load is still an implicit re-prompt for as long as
 * `payouts_enabled` stays false, but pressing Skip won't nag again this session.
 */
export default function OnboardingGate() {
  const { provider, refreshProvider } = useAuth();
  const [agreedTerms, setAgreedTerms] = useState(false);
  const [agreedMarketing, setAgreedMarketing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [skippedConnect, setSkippedConnect] = useState(
    () => !!provider && sessionStorage.getItem(connectSkippedKey(provider.id)) === '1'
  );

  if (!provider) return null;

  async function acceptTerms() {
    setError(null);
    setBusy(true);
    try {
      await apiPost('/api/vendor/terms/accept', {
        provider_id: provider!.id,
        marketing_consent: agreedMarketing,
      });
      await refreshProvider();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save that — please try again.');
    } finally {
      setBusy(false);
    }
  }

  async function connectStripe() {
    setError(null);
    setBusy(true);
    try {
      const { url } = await apiPost<{ url?: string }>('/api/vendor/stripe/connect', {
        provider_id: provider!.id,
      });
      if (url) window.location.href = url;
      else setError('Could not open Stripe just now — please try again.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Payments aren’t set up on this account yet.');
    } finally {
      setBusy(false);
    }
  }

  function skipConnect() {
    sessionStorage.setItem(connectSkippedKey(provider!.id), '1');
    setSkippedConnect(true);
  }

  const shell = (children: React.ReactNode) => (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-10">
      <div className="w-full max-w-lg rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
        {children}
      </div>
    </div>
  );

  if (!provider.vendor_terms_accepted_at) {
    return shell(
      <>
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-pink-100">
            <Shield className="h-5 w-5 text-[#FA4D8D]" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-gray-900">Before you get started</h1>
            <p className="text-sm text-gray-500">One-time — as the business owner.</p>
          </div>
        </div>

        {error && (
          <div className="mb-4 rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="space-y-3">
          <div className="flex items-start gap-3">
            <Checkbox
              id="onboarding-terms"
              checked={agreedTerms}
              onCheckedChange={(c) => setAgreedTerms(c === true)}
              className="mt-0.5"
            />
            <label htmlFor="onboarding-terms" className="cursor-pointer text-sm text-gray-700">
              I hereby acknowledge that I have read the{' '}
              <a href={TERMS_URL} target="_blank" rel="noreferrer" className="text-[#FA4D8D] underline">
                Terms of Service
              </a>
              ,{' '}
              <a href={TOU_URL} target="_blank" rel="noreferrer" className="text-[#FA4D8D] underline">
                Terms of Use
              </a>{' '}
              and{' '}
              <a href={PRIVACY_URL} target="_blank" rel="noreferrer" className="text-[#FA4D8D] underline">
                Privacy Policy
              </a>{' '}
              and confirm that I am in agreement with and legally bound by such terms, as modified from
              time to time.
            </label>
          </div>
          <div className="flex items-start gap-3">
            <Checkbox
              id="onboarding-marketing"
              checked={agreedMarketing}
              onCheckedChange={(c) => setAgreedMarketing(c === true)}
              className="mt-0.5"
            />
            <label htmlFor="onboarding-marketing" className="cursor-pointer text-sm text-gray-700">
              I agree and consent to receive marketing communications from BabyBrain to update me on offers,
              promotions, discounts, events, news, etc. relating to BabyBrain's products and services via any
              means of communication such as via email.
            </label>
          </div>
        </div>

        <Button
          onClick={acceptTerms}
          disabled={busy || !agreedTerms || !agreedMarketing}
          className="gradient-primary mt-6 w-full rounded-xl text-white hover:opacity-90"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Agree & continue'}
        </Button>
      </>
    );
  }

  if (!provider.payouts_enabled && !skippedConnect) {
    return shell(
      <>
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-purple-100">
            <Wallet className="h-5 w-5 text-purple-600" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-gray-900">Get paid for bookings</h1>
            <p className="text-sm text-gray-500">Connect a Stripe account for {provider.business_name}.</p>
          </div>
        </div>

        {error && (
          <div className="mb-4 rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="space-y-2 mb-6 text-sm text-gray-600">
          <p className="flex items-start gap-2">
            <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-green-600" />
            Parents pay at checkout. Stripe's fees and BabyBrain's commission come off automatically, and the
            rest is paid into your bank account.
          </p>
          <p className="flex items-start gap-2">
            <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-green-600" />
            Your bank and identity details go straight to Stripe — BabyBrain never sees them.
          </p>
        </div>

        <Button
          onClick={connectStripe}
          disabled={busy}
          className="gradient-primary w-full rounded-xl text-white hover:opacity-90"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Connect with Stripe'}
        </Button>
        <button
          type="button"
          onClick={skipConnect}
          disabled={busy}
          className="mt-3 w-full text-center text-sm text-gray-500 hover:text-gray-700"
        >
          I'll do this later
        </button>
      </>
    );
  }

  // Terms accepted, and either payouts are on or the owner chose to skip
  // Connect for now — let them into the portal.
  return <Outlet />;
}
