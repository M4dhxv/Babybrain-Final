import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CalendarDays,
  Crown,
  CheckCircle,
  ChevronRight,
  Lock,
  AlertTriangle,
  Star,
  Rocket,
  CalendarCheck,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiPost } from '@/lib/api';
import { useAuth } from '@/auth/AuthProvider';
import { planMeta, nextPlan } from '@/lib/plans';

const sgDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-SG', { timeZone: 'Asia/Singapore', day: 'numeric', month: 'long', year: 'numeric' });

export default function BillingPage() {
  const navigate = useNavigate();
  const { provider, subscription } = useAuth();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const plan = planMeta(subscription?.plan);
  const upgrade = nextPlan(subscription?.plan);
  const active = (subscription?.status ?? 'active') === 'active' || subscription?.status === 'trialing';

  // Redirects to the relevant Stripe hosted flow. Shows a clear message if
  // payments aren't configured yet (route returns an error) instead of a
  // dead button.
  async function stripe(path: string, label: string) {
    if (!provider) return;
    setMsg(null);
    setBusy(label);
    try {
      const { url } = await apiPost<{ url?: string }>(path, { provider_id: provider.id });
      if (url) window.location.href = url;
      else setMsg('Could not start that just now — please try again.');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Payments aren’t set up on this account yet.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="relative">
      {/* Top Bar */}
      <div className="flex flex-col items-center gap-3 px-4 py-5 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:px-8">
        <div className="flex w-full items-center justify-center gap-3 sm:w-auto sm:justify-start">
          <button onClick={() => navigate('/dashboard')} className="p-2 hover:bg-gray-100 rounded-lg">
            <ChevronRight className="w-5 h-5 text-gray-600 rotate-180" />
          </button>
          <div className="text-center sm:text-left">
            <h1 className="text-2xl font-bold text-gray-900">Manage Subscription</h1>
            <p className="text-sm text-gray-500 mt-1">View and manage your subscription details.</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-3 sm:justify-start">
          <span className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-full ${active ? 'bg-green-300 text-green-800' : 'bg-gray-100 text-gray-600'}`}>
            <div className={`w-1.5 h-1.5 rounded-full ${active ? 'bg-green-500' : 'bg-gray-400'}`} />
            {subscription?.status === 'trialing' ? 'Trial' : active ? 'Active' : (subscription?.status ?? 'Inactive')}
          </span>
          {plan.isPaid && subscription?.current_period_end && (
            <div className="hidden md:flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 rounded-xl text-sm text-gray-500">
              <CalendarCheck className="w-4 h-4" />
              {subscription.cancel_at_period_end ? 'Access until' : 'Renews'} {sgDate(subscription.current_period_end)}
            </div>
          )}
          <div className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 rounded-xl text-sm text-gray-500">
            <CalendarDays className="w-4 h-4" />
            {plan.short}
          </div>
        </div>
      </div>

      {msg && (
        <div className="mx-4 mb-4 rounded-xl bg-yellow-50 border border-yellow-300 px-4 py-3 text-sm text-yellow-800 sm:mx-8">
          {msg}
        </div>
      )}

      <div className="px-4 pb-8 space-y-6 sm:px-8">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* Compare & Upgrade */}
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h3 className="font-semibold text-gray-900 mb-1">Compare & upgrade</h3>
            <p className="text-xs text-gray-500 mb-4">Choose the right plan as you grow.</p>

            <div className="grid grid-cols-1 gap-4 mb-4 sm:grid-cols-2">
              <div className="p-4 border-2 border-[#C90044] rounded-xl relative bg-pink-50/30">
                <div className="absolute -top-2.5 right-3 px-2 py-0.5 bg-pink-100 text-[#C90044] text-xs font-medium rounded">
                  Current plan
                </div>
                <div className="flex items-center gap-2 mb-2">
                  <Crown className="w-4 h-4 text-[#C90044]" />
                  <span className="font-semibold text-gray-900 text-sm">{plan.label}</span>
                </div>
                <p className="text-xs text-gray-500 mb-3">{plan.tagline}</p>
                <div className="text-sm font-bold text-[#C90044]">{plan.price}</div>
                <div className="text-xs text-gray-500">{plan.commission}</div>
              </div>
              {upgrade ? (
                <div className="p-4 border border-purple-300 rounded-xl relative">
                  <div className="absolute -top-2.5 right-3 px-2 py-0.5 bg-purple-300 text-purple-800 text-xs font-medium rounded">
                    Next step up
                  </div>
                  <div className="flex items-center gap-2 mb-2">
                    <Star className="w-4 h-4 text-purple-600" />
                    <span className="font-semibold text-gray-900 text-sm">{upgrade.label}</span>
                  </div>
                  <p className="text-xs text-gray-500 mb-3">{upgrade.tagline}</p>
                  <div className="text-sm font-bold text-purple-600">{upgrade.price}</div>
                  <div className="flex items-center justify-between">
                    <div className="text-xs text-gray-500">{upgrade.commission}</div>
                    <button onClick={() => navigate('/plans')} className="text-xs font-semibold text-purple-700 hover:underline">
                      Upgrade →
                    </button>
                  </div>
                </div>
              ) : (
                <div className="p-4 border border-gray-200 rounded-xl flex items-center justify-center text-center">
                  <p className="text-xs text-gray-500">You’re on our top plan 🎉</p>
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-gray-500">
                {upgrade ? `Need more exposure? Upgrade to ${upgrade.label}.` : 'You have access to every feature.'}
              </p>
              <button onClick={() => navigate('/plans')} className="text-xs text-[#C90044] font-medium flex items-center gap-1">
                Learn more about plans
                <ChevronRight className="w-3 h-3" />
              </button>
            </div>

            {/* What's Included */}
            <div className="mt-6 pt-6 border-t border-gray-200">
              <h4 className="font-semibold text-gray-900 mb-4">What's included</h4>
              <div className="space-y-2">
                {(upgrade ?? plan).perks.map((perk) => (
                  <div key={perk} className="flex items-start gap-2">
                    <CheckCircle className="mt-0.5 w-4 h-4 text-green-500 flex-shrink-0" />
                    <span className="text-sm text-gray-700">{perk}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Right Column */}
          <div className="space-y-6">
            {/* Payment Method — only on a paid plan (a card is on file) */}
            {plan.isPaid && (
              <div className="bg-white rounded-xl border border-gray-200 p-6">
                <h3 className="font-semibold text-gray-900 mb-4">Payment Method</h3>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="text-sm text-gray-600">Manage your card and invoices in the Stripe billing portal.</div>
                  <Button onClick={() => stripe('/api/vendor/stripe/portal', 'card')} disabled={busy === 'card'} variant="outline" className="rounded-lg border-gray-300 text-gray-700 hover:bg-gray-50 text-sm flex-shrink-0">
                    {busy === 'card' ? 'Opening…' : 'Manage billing'}
                  </Button>
                </div>
              </div>
            )}

            {/* Stripe Payouts */}
            <div className="bg-white rounded-xl border border-gray-200 p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-xl bg-purple-100 flex items-center justify-center">
                  <span className="text-purple-600 font-bold text-sm">S</span>
                </div>
                <div>
                  <h3 className="font-semibold text-gray-900">Stripe payouts</h3>
                </div>
              </div>
              <div className="flex flex-col gap-3 mb-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="text-xs text-gray-500 mb-1">Payout account status</div>
                  {/* Was hardcoded to "Connected / Pending" regardless of
                      whether the vendor had ever even started onboarding —
                      now reflects the real stripe_account_id/payouts_enabled
                      state on the provider row. */}
                  {provider?.payouts_enabled ? (
                    <span className="inline-flex items-center px-2.5 py-1 bg-green-300 text-green-800 text-xs font-medium rounded-full">
                      Active — payouts on
                    </span>
                  ) : provider?.stripe_account_id ? (
                    <span className="inline-flex items-center px-2.5 py-1 bg-yellow-300 text-yellow-800 text-xs font-medium rounded-full">
                      Connected / Pending
                    </span>
                  ) : (
                    <span className="inline-flex items-center px-2.5 py-1 bg-gray-100 text-gray-600 text-xs font-medium rounded-full">
                      Not connected
                    </span>
                  )}
                </div>
                <Button onClick={() => stripe('/api/vendor/stripe/connect', 'payouts')} disabled={busy === 'payouts'} variant="outline" className="rounded-lg border-gray-300 text-gray-700 hover:bg-gray-50 text-sm">
                  {busy === 'payouts' ? 'Opening…' : provider?.stripe_account_id ? 'Manage payouts' : 'Connect payouts'}
                </Button>
              </div>
              <div className="flex items-center gap-2 text-xs text-gray-500">
                <Lock className="w-3.5 h-3.5" />
                Your payout information is secure and encrypted.
              </div>
            </div>

            {/* Boost Visibility */}
            <div className="bg-gradient-to-br from-purple-50 to-pink-50 rounded-xl border border-purple-300 p-6">
              <div className="flex flex-col items-start gap-4 sm:flex-row">
                <div className="w-12 h-12 rounded-xl bg-purple-100 flex items-center justify-center">
                  <Rocket className="w-6 h-6 text-purple-600" />
                </div>
                <div className="flex-1">
                  <h3 className="font-semibold text-gray-900 mb-1">Boost visibility</h3>
                  <p className="text-xs text-gray-500 mb-1">Pay for featured / prime placement</p>
                  <p className="text-xs text-gray-500 mb-3">Get more views and grow faster.</p>
                </div>
                <Button onClick={() => navigate('/plans')} variant="outline" className="rounded-lg border-purple-300 text-purple-700 hover:bg-purple-50 text-sm">
                  Go Premium
                </Button>
              </div>
            </div>
          </div>
        </div>

        {/* Cancel Subscription — only relevant on a paid plan */}
        {plan.isPaid && (
          <div className="bg-red-50 rounded-xl border border-red-200 p-6">
            <div className="flex flex-col items-start gap-4 sm:flex-row">
              <div className="w-10 h-10 rounded-xl bg-red-100 flex items-center justify-center flex-shrink-0">
                <AlertTriangle className="w-5 h-5 text-red-600" />
              </div>
              <div className="flex-1">
                <h3 className="font-semibold text-red-600 mb-1">Cancel Subscription</h3>
                <p className="text-sm text-gray-600">
                  If you cancel, your subscription will remain active until the end of your current billing period.
                </p>
              </div>
              <Button
                onClick={() => {
                  if (window.confirm(`Cancel your ${plan.short.replace(' Plan', '')} subscription? It stays active until the end of the current billing period.`)) {
                    stripe('/api/vendor/stripe/portal', 'cancel');
                  }
                }}
                disabled={busy === 'cancel'}
                variant="outline"
                className="rounded-lg border-red-300 text-red-600 hover:bg-red-100 text-sm flex-shrink-0"
              >
                {busy === 'cancel' ? 'Opening…' : 'Cancel Plan'}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
