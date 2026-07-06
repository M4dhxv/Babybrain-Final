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

const includedFeatures = [
  'Direct-to-user messaging',
  'Booking & waitlist management',
  'Attendance + make-up tokens',
  'Stripe payments',
  'Automated reminders',
  'Analytics & insights',
  'Featured-placement eligible',
  'Multiple locations & team access',
];

export default function BillingPage() {
  const navigate = useNavigate();
  const { provider } = useAuth();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

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
      <div className="flex items-center justify-between px-8 py-5">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate('/dashboard')} className="p-2 hover:bg-gray-100 rounded-lg">
            <ChevronRight className="w-5 h-5 text-gray-600 rotate-180" />
          </button>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Manage Subscription</h1>
            <p className="text-sm text-gray-500 mt-1">View and manage your subscription details.</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 rounded-xl text-sm text-gray-500">
            <CalendarDays className="w-4 h-4" />
            Current period: 13 Jun – 19 Jun 2026
          </div>
        </div>
      </div>

      {msg && (
        <div className="mx-8 mb-4 rounded-xl bg-yellow-50 border border-yellow-200 px-4 py-3 text-sm text-yellow-800">
          {msg}
        </div>
      )}

      <div className="px-8 pb-8 space-y-6">
        {/* Current Plan Card */}
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <div className="flex items-start gap-6">
            <div className="w-20 h-20 rounded-2xl bg-pink-100 flex items-center justify-center">
              <Crown className="w-10 h-10 text-[#E91E63]" />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-3 mb-2">
                <h2 className="text-xl font-bold text-gray-900">Growth — SGD 99 / month</h2>
                <span className="flex items-center gap-1 px-2.5 py-1 bg-green-100 text-green-700 text-xs font-medium rounded-full">
                  <div className="w-1.5 h-1.5 bg-green-500 rounded-full" />
                  Active
                </span>
              </div>
            </div>
            <div className="flex gap-8">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-xl bg-pink-100 flex items-center justify-center">
                  <CalendarCheck className="w-5 h-5 text-[#E91E63]" />
                </div>
                <div>
                  <div className="text-xs text-gray-500">Next billing date</div>
                  <div className="text-sm font-semibold text-gray-900">12 July 2026</div>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-xl bg-pink-100 flex items-center justify-center">
                  <CalendarDays className="w-5 h-5 text-[#E91E63]" />
                </div>
                <div>
                  <div className="text-xs text-gray-500">Started on</div>
                  <div className="text-sm font-semibold text-gray-900">12 April 2026</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-6">
          {/* What's Included */}
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h3 className="font-semibold text-gray-900 mb-4">What's included</h3>
            <div className="grid grid-cols-2 gap-3">
              {includedFeatures.map((feature, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <CheckCircle className="w-4 h-4 text-green-500 flex-shrink-0" />
                  <span className="text-sm text-gray-700">{feature}</span>
                </div>
              ))}
            </div>

            {/* Compare & Upgrade */}
            <div className="mt-6 pt-6 border-t border-gray-200">
              <h4 className="font-semibold text-gray-900 mb-1">Compare & upgrade</h4>
              <p className="text-xs text-gray-500 mb-4">Choose the right plan as you grow.</p>

              <div className="grid grid-cols-2 gap-4 mb-4">
                <div className="p-4 border-2 border-[#E91E63] rounded-xl relative bg-pink-50/30">
                  <div className="absolute -top-2.5 right-3 px-2 py-0.5 bg-pink-100 text-[#E91E63] text-xs font-medium rounded">
                    Current plan
                  </div>
                  <div className="flex items-center gap-2 mb-2">
                    <Crown className="w-4 h-4 text-[#E91E63]" />
                    <span className="font-semibold text-gray-900 text-sm">Growth (Booking Platform)</span>
                  </div>
                  <p className="text-xs text-gray-500 mb-1">Manage bookings & grow</p>
                  <p className="text-xs text-gray-500 mb-3">All core features</p>
                  <div className="text-sm font-bold text-[#E91E63]">SGD 99 / month</div>
                </div>
                <div className="p-4 border border-purple-200 rounded-xl relative">
                  <div className="absolute -top-2.5 right-3 px-2 py-0.5 bg-purple-100 text-purple-700 text-xs font-medium rounded">
                    Next step up
                  </div>
                  <div className="flex items-center gap-2 mb-2">
                    <Star className="w-4 h-4 text-purple-600" />
                    <span className="font-semibold text-gray-900 text-sm">Pro (Scale)</span>
                  </div>
                  <p className="text-xs text-gray-500 mb-1">Featured placement & priority ranking</p>
                  <p className="text-xs text-gray-500 mb-3">Advanced analytics & promotions</p>
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-bold text-purple-600">SGD 199 / month</div>
                    <button onClick={() => navigate('/plans')} className="text-xs font-semibold text-purple-700 hover:underline">
                      Upgrade →
                    </button>
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between">
                <p className="text-xs text-gray-500">Need more exposure? Upgrade to Boost.</p>
                <button onClick={() => navigate('/plans')} className="text-xs text-[#E91E63] font-medium flex items-center gap-1">
                  Learn more about plans
                  <ChevronRight className="w-3 h-3" />
                </button>
              </div>
            </div>
          </div>

          {/* Right Column */}
          <div className="space-y-6">
            {/* Payment Method */}
            <div className="bg-white rounded-xl border border-gray-200 p-6">
              <h3 className="font-semibold text-gray-900 mb-4">Payment Method</h3>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-8 bg-white border border-gray-200 rounded flex items-center justify-center">
                    <span className="text-blue-800 font-bold text-xs italic">VISA</span>
                  </div>
                  <div>
                    <div className="text-sm font-medium text-gray-900">Visa •••• 4242</div>
                    <div className="text-xs text-gray-500">Expires 09/28</div>
                  </div>
                </div>
                <Button onClick={() => stripe('/api/vendor/stripe/portal', 'card')} disabled={busy === 'card'} variant="outline" className="rounded-lg border-gray-300 text-gray-700 hover:bg-gray-50 text-sm">
                  {busy === 'card' ? 'Opening…' : 'Update Card'}
                </Button>
              </div>
            </div>

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
              <div className="flex items-center justify-between mb-4">
                <div>
                  <div className="text-xs text-gray-500 mb-1">Payout account status</div>
                  <span className="inline-flex items-center px-2.5 py-1 bg-yellow-100 text-yellow-700 text-xs font-medium rounded-full">
                    Connected / Pending
                  </span>
                </div>
                <Button onClick={() => stripe('/api/vendor/stripe/connect', 'payouts')} disabled={busy === 'payouts'} variant="outline" className="rounded-lg border-gray-300 text-gray-700 hover:bg-gray-50 text-sm">
                  {busy === 'payouts' ? 'Opening…' : 'Manage payouts'}
                </Button>
              </div>
              <div className="flex items-center gap-2 text-xs text-gray-500">
                <Lock className="w-3.5 h-3.5" />
                Your payout information is secure and encrypted.
              </div>
            </div>

            {/* Boost Visibility */}
            <div className="bg-gradient-to-br from-purple-50 to-pink-50 rounded-xl border border-purple-200 p-6">
              <div className="flex items-start gap-4">
                <div className="w-12 h-12 rounded-xl bg-purple-100 flex items-center justify-center">
                  <Rocket className="w-6 h-6 text-purple-600" />
                </div>
                <div className="flex-1">
                  <h3 className="font-semibold text-gray-900 mb-1">Boost visibility</h3>
                  <p className="text-xs text-gray-500 mb-1">Pay for featured / prime placement</p>
                  <p className="text-xs text-gray-500 mb-3">Get more views and grow faster.</p>
                </div>
                <Button onClick={() => navigate('/activities')} variant="outline" className="rounded-lg border-purple-300 text-purple-700 hover:bg-purple-50 text-sm">
                  Set up Boost
                </Button>
              </div>
            </div>
          </div>
        </div>

        {/* Cancel Subscription */}
        <div className="bg-red-50 rounded-xl border border-red-200 p-6">
          <div className="flex items-start gap-4">
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
                if (window.confirm('Cancel your Growth subscription? It stays active until the end of the current billing period.')) {
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
      </div>
    </div>
  );
}
