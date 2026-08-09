import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, X, Star } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import SiteFooter from '@/components/SiteFooter';
import { apiPost } from '@/lib/api';
import { BrandLogo } from '@/components/BrandLogo';
import { useAuth } from '@/auth/AuthProvider';

/* The four tiers, per the founder's pricing deck.
 *
 * Pay As You Go sits between Free and Growth: it unlocks taking bookings and
 * payments with no monthly fee, but not the admin suite (waitlist, packages,
 * make-up tokens, consent tracking, reminders, attendance) which is what Growth
 * is for. Without that split PAYG would strictly dominate Growth — same 10%
 * commission as Pro, and no monthly fee against Growth's $99 + 15%. Flagged for
 * confirmation. */
const plans = [
  {
    name: 'FREE',
    planKey: null as 'growth' | 'pro' | null,
    price: '0',
    color: 'text-green-600',
    tagline: 'Improve trust with parents',
    buttonText: 'Claim Listing',
    buttonVariant: 'outline' as const,
    buttonClass: 'border-green-500 text-green-600 hover:bg-green-50',
    featured: false,
    commission: 'Listing only — no booking fees',
    perks: ['Edit profile', 'Upload photos', 'Increase website traffic', 'Parents can leave reviews'],
  },
  {
    name: 'PAY AS YOU GO',
    planKey: null as 'growth' | 'pro' | null,
    price: '0',
    color: 'text-blue-600',
    tagline: 'Take bookings without a monthly fee',
    buttonText: 'Start Selling',
    buttonVariant: 'outline' as const,
    buttonClass: 'border-blue-500 text-blue-600 hover:bg-blue-50',
    featured: false,
    commission: '10% of each booked class + Stripe platform costs + GST',
    perks: [
      'Everything in Free',
      'Take bookings on BabyBrain',
      'Stripe payments',
      'Pay only when you get booked',
    ],
  },
  {
    name: 'GROWTH',
    planKey: 'growth' as 'growth' | 'pro' | null,
    price: '99',
    color: 'text-[#C90044]',
    tagline: 'Turn discovery into bookings & reduce admin',
    buttonText: 'Start Growing',
    buttonVariant: 'default' as const,
    buttonClass: 'gradient-primary text-white hover:opacity-90',
    featured: true,
    badge: 'MOST POPULAR',
    yearlyPrice: '1,089/year (1 month free)',
    commission: '15% booking commission + Stripe platform costs + GST',
    perks: [
      'Everything in Free',
      'Onboarding and ongoing support',
      'Direct to user messaging',
      'Availability, booking & waitlist management, package and make up token allocation either hosted on BabyBrain or integrated to your site',
      'Ability to track medical disclosures, collect consent, agree terms, warranties, waivers',
      'Stripe payments with promotions enabled',
      'Automated reminders, weekly class availability etc',
      'Attendance tracking',
    ],
  },
  {
    name: 'PRO',
    planKey: 'pro' as 'growth' | 'pro' | null,
    price: '199',
    color: 'text-purple-600',
    tagline: 'Gain clear insight & accelerate growth',
    buttonText: 'Go Pro',
    buttonVariant: 'outline' as const,
    buttonClass: 'border-purple-500 text-purple-600 hover:bg-purple-50',
    featured: false,
    yearlyPrice: '2,189/year (1 month free)',
    commission: '10% booking commission + Stripe platform costs + GST',
    perks: [
      'Everything in Growth',
      'Featured placement',
      'Priority ranking',
      'E-mail blasts with class availability three times a week',
      'Advanced analytics',
    ],
  },
];

const features = [
  { name: 'Edit Profile & Upload Photos', free: true, payg: true, growth: true, pro: true },
  { name: 'Website Traffic', free: true, payg: true, growth: true, pro: true },
  { name: 'Reviews', free: true, payg: true, growth: true, pro: true },
  { name: 'Take Bookings', free: false, payg: true, growth: true, pro: true },
  { name: 'Stripe Payments', free: false, payg: true, growth: true, pro: true },
  { name: 'Onboarding & Ongoing Support', free: false, payg: false, growth: true, pro: true },
  { name: 'Direct to User Messaging', free: false, payg: false, growth: true, pro: true },
  { name: 'Waitlist Management', free: false, payg: false, growth: true, pro: true },
  { name: 'Package & Make-up Tokens', free: false, payg: false, growth: true, pro: true },
  { name: 'Medical Disclosures, Consent & Waivers', free: false, payg: false, growth: true, pro: true },
  { name: 'Promotions on Stripe Payments', free: false, payg: false, growth: true, pro: true },
  { name: 'Automated Reminders', free: false, payg: false, growth: true, pro: true },
  { name: 'Attendance Tracking', free: false, payg: false, growth: true, pro: true },
  { name: 'Featured Placement', free: false, payg: false, growth: false, pro: true },
  { name: 'Priority Ranking', free: false, payg: false, growth: false, pro: true },
  { name: 'Email Blasts (3x weekly)', free: false, payg: false, growth: false, pro: true },
  { name: 'Advanced Analytics', free: false, payg: false, growth: false, pro: true },
];

export default function PlansPage() {
  const navigate = useNavigate();
  const { session, provider } = useAuth();
  const [checkoutBusy, setCheckoutBusy] = useState<string | null>(null);
  const [checkoutError, setCheckoutError] = useState<{ plan: string; message: string } | null>(null);
  const [optedOut, setOptedOut] = useState(false);
  const [optOutOpen, setOptOutOpen] = useState(false);
  const [optOutName, setOptOutName] = useState('');
  const [optOutEmail, setOptOutEmail] = useState('');
  const [optOutNote, setOptOutNote] = useState('');
  const [optOutBusy, setOptOutBusy] = useState(false);
  const [optOutError, setOptOutError] = useState<string | null>(null);

  /* QA: "click upgrade to growth and then start growing and it just takes me
     back to the dashboard still on the free plan." Every paid-plan button sent
     the click to /login unconditionally, and the login page redirects an
     already-signed-in session straight to /dashboard — so a vendor who was
     already logged in got bounced right back to where they started, on Free,
     with no indication anything had gone wrong.
     A signed-in owner now starts real Stripe checkout for the plan clicked;
     a signed-out visitor still goes to /login, which is the correct behaviour
     for them. */
  async function selectPlan(planKey: 'growth' | 'pro' | null, planName: string) {
    if (!planKey) {
      // FREE -> claim a listing. PAYG has no subscription (it's commission-only),
      // so an existing owner goes to Billing to turn on Stripe payouts; a guest
      // signs in first.
      if (planName === 'PAY AS YOU GO' && session) { navigate('/billing'); return; }
      navigate(session ? (provider ? '/dashboard' : '/claim-business') : (planName === 'FREE' ? '/claim-business' : '/login'));
      return;
    }
    if (!session) { navigate('/login'); return; }
    if (!provider) {
      setCheckoutError({ plan: planKey, message: 'Claim your business first, then come back to upgrade.' });
      return;
    }
    setCheckoutError(null);
    setCheckoutBusy(planKey);
    try {
      const { url } = await apiPost<{ url?: string }>('/api/vendor/stripe/subscription', {
        provider_id: provider.id,
        plan: planKey,
      });
      if (url) window.location.href = url;
      else setCheckoutError({ plan: planKey, message: 'Could not start checkout — please try again.' });
    } catch (e) {
      setCheckoutError({ plan: planKey, message: e instanceof Error ? e.message : 'Payments aren’t set up on this account yet.' });
    } finally {
      setCheckoutBusy(null);
    }
  }

  async function submitOptOut(e: React.FormEvent) {
    e.preventDefault();
    if (!optOutName.trim()) return setOptOutError('Please tell us the business name.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(optOutEmail.trim())) {
      return setOptOutError('Please enter a valid email so we can confirm.');
    }
    setOptOutBusy(true);
    setOptOutError(null);
    try {
      // Routed through the contact endpoint so it is stored and shows up in the
      // founder's admin inbox even while email delivery is unconfigured.
      await apiPost('/api/contact', {
        name: optOutName.trim(),
        email: optOutEmail.trim(),
        subject: `Listing opt-out request — ${optOutName.trim()}`,
        message:
          `${optOutName.trim()} has asked to be removed from BabyBrain.\n` +
          `Contact: ${optOutEmail.trim()}\n\n${optOutNote.trim() || '(no additional notes)'}`,
      });
      setOptedOut(true);
    } catch (err) {
      setOptOutError(
        err instanceof Error ? err.message : "We couldn't send that — please email hello@babybrain.sg."
      );
    } finally {
      setOptOutBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-white">
      {/* Header */}
      <header className="flex items-center justify-between px-8 py-4 border-b border-gray-100">
        <div
          className="flex items-center gap-2 cursor-pointer"
          onClick={() => navigate('/')}
        >
          <BrandLogo className="h-10" />
          
        </div>
        <nav className="flex items-center gap-10">
          <button onClick={() => navigate('/')} className="text-sm font-medium text-gray-700 hover:text-gray-900 pb-1">Home</button>
          <button className="text-sm font-medium text-[#C90044] border-b-2 border-[#C90044] pb-1">Plans</button>
          <button onClick={() => { window.location.href = 'mailto:hello@babybrain.sg'; }} className="text-sm font-medium text-gray-700 hover:text-gray-900 pb-1">Contact</button>
        </nav>
        <div className="flex items-center gap-3">
          <Button variant="outline" onClick={() => navigate('/login')} className="rounded-full px-6 border-gray-300 text-gray-700 hover:bg-gray-50">
            Sign In
          </Button>
          <Button onClick={() => navigate('/login')} className="rounded-full px-6 gradient-primary text-white hover:opacity-90 border-0">
            Upgrade Your Listing
          </Button>
        </div>
      </header>

      {/* Pricing Section */}
      <div className="max-w-5xl mx-auto px-8 py-12">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold text-[#111A4C] mb-3">Simple pricing</h1>
          <p className="text-gray-600 mb-6">Choose the plan that fits your business.</p>
          <Button onClick={() => navigate('/login')} className="gradient-primary text-white px-8 py-3 rounded-xl text-sm font-semibold hover:opacity-90">
            Upgrade Your Listing
          </Button>
        </div>

        {/* Pricing Cards */}
        <div className="grid gap-5 mb-10 md:grid-cols-2 xl:grid-cols-4 items-start">
          {plans.map((plan) => (
            <div
              key={plan.name}
              className={cn(
                'relative rounded-2xl p-6',
                plan.featured
                  ? 'border-2 border-[#C90044] bg-gradient-to-b from-pink-50/50 to-white'
                  : 'border border-gray-200 bg-white'
              )}
            >
              {plan.badge && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                  <div className="flex items-center gap-1 px-3 py-1 bg-[#C90044] text-white text-xs font-semibold rounded-full">
                    <Star className="w-3 h-3" />
                    {plan.badge}
                  </div>
                </div>
              )}

              <div className="text-center pt-2">
                <h3 className={cn('text-lg font-bold mb-4', plan.color)}>{plan.name}</h3>
                <div className="flex items-baseline justify-center gap-1 mb-2">
                  <span className={cn('text-sm font-medium', plan.color)}>SGD</span>
                  <span className={cn('text-5xl font-extrabold', plan.color)}>{plan.price}</span>
                  <span className="text-gray-500 text-sm">/month</span>
                </div>
                {plan.yearlyPrice ? (
                  <p className="text-xs text-gray-500 mb-1">
                    or SGD <span className="text-[#C90044] font-medium">{plan.yearlyPrice}</span>
                  </p>
                ) : (
                  <div className="mb-1" />
                )}
                {plan.commission && (
                  <p className="text-[11px] text-gray-400 mb-3">{plan.commission}</p>
                )}
                {plan.tagline && (
                  <p className="text-[13px] font-semibold text-gray-700 mb-3">{plan.tagline}</p>
                )}
                <ul className="mb-4 space-y-1.5 text-left">
                  {plan.perks.map((perk) => (
                    <li key={perk} className="flex gap-2 text-[12.5px] leading-5 text-gray-600">
                      <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-green-500" />
                      <span>{perk}</span>
                    </li>
                  ))}
                </ul>

                <Button
                  onClick={() => selectPlan(plan.planKey, plan.name)}
                  disabled={checkoutBusy === plan.planKey}
                  className={cn('w-full rounded-xl py-3 font-semibold', plan.buttonClass)}
                  variant={plan.buttonVariant}
                >
                  {checkoutBusy === plan.planKey ? 'Redirecting to Stripe…' : plan.buttonText}
                </Button>
                {checkoutError?.plan === plan.planKey && (
                  <p className="mt-2 text-xs font-medium text-red-600">{checkoutError.message}</p>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Comparison Table */}
        <div className="border border-gray-200 rounded-xl overflow-hidden">
          <div className="grid grid-cols-5 bg-gray-50 px-6 py-3 text-sm font-semibold text-gray-700">
            <div>Compare Plans</div>
            <div className="text-center text-green-600">Free</div>
            <div className="text-center text-blue-600">Pay As You Go</div>
            <div className="text-center text-[#C90044]">Growth</div>
            <div className="text-center text-purple-600">Pro</div>
          </div>
          {features.map((feature, idx) => (
            <div
              key={feature.name}
              className={cn(
                'grid grid-cols-5 px-6 py-3 text-sm',
                idx % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'
              )}
            >
              <div className="text-gray-800 font-medium">{feature.name}</div>
              <div className="flex justify-center">
                {feature.free ? (
                  <Check className="w-4 h-4 text-green-500" />
                ) : (
                  <X className="w-4 h-4 text-red-400" />
                )}
              </div>
              <div className="flex justify-center">
                {feature.payg ? (
                  <Check className="w-4 h-4 text-blue-500" />
                ) : (
                  <X className="w-4 h-4 text-red-400" />
                )}
              </div>
              <div className="flex justify-center">
                {feature.growth ? (
                  <Check className="w-4 h-4 text-[#C90044]" />
                ) : (
                  <X className="w-4 h-4 text-red-400" />
                )}
              </div>
              <div className="flex justify-center">
                {feature.pro ? (
                  <Check className="w-4 h-4 text-purple-500" />
                ) : (
                  <X className="w-4 h-4 text-red-400" />
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Opt out / remove listing.
            This used to confirm "Request received" on a window.confirm alone:
            nothing was sent and nobody could tell which business had asked. It
            now collects the business name and an email and records the request,
            so it lands in the founder's contact inbox with an identity. */}
        <div className="mt-10 border-t border-gray-100 pt-6">
          {optedOut ? (
            <p className="text-center text-sm text-gray-600">
              Request received — our team will remove your listing within 3 working days.
              You can re-list any time.
            </p>
          ) : !optOutOpen ? (
            <div className="text-center">
              <p className="text-sm text-gray-500 mb-2">Don't want to be listed on BabyBrain?</p>
              <button
                onClick={() => setOptOutOpen(true)}
                className="text-sm font-semibold text-red-500 hover:text-red-600 underline underline-offset-4"
              >
                Opt out / remove my listing
              </button>
            </div>
          ) : (
            <form onSubmit={submitOptOut} className="mx-auto max-w-md">
              <h3 className="text-center font-bold text-gray-900">Remove my listing</h3>
              <p className="mt-1 text-center text-sm text-gray-500">
                Tell us which business to remove and we'll confirm by email.
              </p>
              <div className="mt-4 space-y-3">
                <input
                  value={optOutName}
                  onChange={(e) => setOptOutName(e.target.value)}
                  placeholder="Business name"
                  className="h-11 w-full rounded-lg border border-gray-200 px-3 text-sm"
                />
                <input
                  type="email"
                  value={optOutEmail}
                  onChange={(e) => setOptOutEmail(e.target.value)}
                  placeholder="Your email"
                  className="h-11 w-full rounded-lg border border-gray-200 px-3 text-sm"
                />
                <textarea
                  value={optOutNote}
                  onChange={(e) => setOptOutNote(e.target.value)}
                  rows={3}
                  placeholder="Anything we should know? (optional)"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
                />
              </div>
              {optOutError && <p className="mt-2 text-sm font-semibold text-red-600">{optOutError}</p>}
              <div className="mt-4 flex gap-3">
                <Button type="submit" disabled={optOutBusy} className="flex-1">
                  {optOutBusy ? 'Sending…' : 'Send request'}
                </Button>
                <Button type="button" variant="outline" onClick={() => setOptOutOpen(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          )}
        </div>
      </div>
      <SiteFooter />
    </div>
  );
}
