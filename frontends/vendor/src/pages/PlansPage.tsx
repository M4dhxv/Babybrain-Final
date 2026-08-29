import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, Star, Menu, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import SiteFooter from '@/components/SiteFooter';
import { apiPost } from '@/lib/api';
import { BrandLogo } from '@/components/BrandLogo';
import { useAuth } from '@/auth/AuthProvider';

/* The three tiers, per the founder's revised pricing deck.
 *
 * "Pay As You Grow" now bundles the full admin suite (waitlist, packages,
 * make-up tokens, consent tracking, reminders, attendance) with no monthly
 * fee — it's funded entirely through the higher 12% commission. Pro and
 * Premium keep their $99/$199 price points from the old Growth/Pro tiers
 * (mapped to the existing 'growth'/'pro' planKeys and Stripe price configs
 * below) but drop the commission as the fee climbs. */
const plans = [
  {
    name: 'PAY AS YOU GROW',
    planKey: null as 'growth' | 'pro' | null,
    price: '0',
    color: 'text-[#A7D8F8]',
    buttonText: 'Start growing',
    buttonClass: 'border-blue-300 text-blue-700 hover:bg-blue-50',
    featured: false,
    commission: '12% commission on classes booked + Stripe fees',
    perks: [
      'Create bespoke class schedule, package, pricing structure',
      'Custom integrations with existing platforms',
      'Availability, booking, waitlist, re-schedule and cancellation management',
      'Online waiver & policy management',
      'Stripe payment integration',
      'Package and make up token allocation',
      'Automated confirmations, reminders, follow ups etc',
      'Attendance tracking',
      'Onboarding and ongoing support',
    ],
  },
  {
    name: 'PRO',
    planKey: 'growth' as 'growth' | 'pro' | null,
    price: '99',
    color: 'text-[#C7B1E6]',
    buttonText: 'Go Pro',
    buttonClass: 'border-purple-300 text-purple-700 hover:bg-purple-50',
    featured: true,
    yearlyPrice: '1,089/year (1 month free)',
    commission: '10% commission on classes booked + Stripe fees',
    perks: [
      'Everything in Pay as you grow',
      'Direct to user messaging and user to user messaging on booked activities',
      'E-mails blasts with class availability twice a week',
      '1 bespoke marketing e-mail and 1 instagram post each month',
    ],
  },
  {
    name: 'PREMIUM',
    planKey: 'pro' as 'growth' | 'pro' | null,
    price: '199',
    color: 'text-[#FFC1D6]',
    buttonText: 'Be Premium',
    buttonClass: 'border-pink-300 text-pink-600 hover:bg-pink-50',
    featured: false,
    yearlyPrice: '2,189/year (1 month free)',
    commission: '8% commission on classes booked + Stripe fees',
    perks: [
      'Everything in Pro',
      'Featured placement',
      'Priority ranking',
      'Activity performance analytics',
      'Priority support',
    ],
  },
];

const features = [
  { name: 'Edit custom built profile', grow: true, pro: true, premium: true },
  { name: 'Bespoke integrations', grow: true, pro: true, premium: true },
  { name: 'Take bookings', grow: true, pro: true, premium: true },
  { name: 'Availability, waitlist, cancellation and re-schedule management', grow: true, pro: true, premium: true },
  { name: 'Online waiver & policy management', grow: true, pro: true, premium: true },
  { name: 'Stripe payment integration', grow: true, pro: true, premium: true },
  { name: 'Automated confirmations, reminders, follow ups etc', grow: true, pro: true, premium: true },
  { name: 'Package and make up token allocation', grow: true, pro: true, premium: true },
  { name: 'Attendance tracking', grow: true, pro: true, premium: true },
  { name: 'Receive reviews', grow: true, pro: true, premium: true },
  { name: 'Onboarding and ongoing support', grow: true, pro: true, premium: true },
  { name: 'Direct to user messaging and user to user messaging on booked activities', grow: false, pro: true, premium: true },
  { name: 'E-mails blasts with class availability twice a week', grow: false, pro: true, premium: true },
  { name: '1 bespoke marketing e-mail and 1 instagram post each month', grow: false, pro: true, premium: true },
  { name: 'Featured placement', grow: false, pro: false, premium: true },
  { name: 'Priority ranking', grow: false, pro: false, premium: true },
  { name: 'Activity performance analytics', grow: false, pro: false, premium: true },
  { name: 'Priority support', grow: false, pro: false, premium: true },
];

export default function PlansPage() {
  const navigate = useNavigate();
  const { session, provider, subscription } = useAuth();
  // Legacy DB rows can carry the old 'premium' value for what the UI now
  // calls the top tier ('pro' planKey), and the free tier's planKey is `null`
  // rather than 'free' — normalize both sides before comparing. Only treat a
  // plan as "current" once a subscription has actually loaded, so signed-out
  // visitors (subscription === null) never match the free tier's null key.
  const isCurrentPlan = (planKey: 'growth' | 'pro' | null) =>
    subscription != null && (planKey ?? 'free') === (subscription.plan === 'premium' ? 'pro' : subscription.plan);
  const [menuOpen, setMenuOpen] = useState(false);
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
  async function selectPlan(planKey: 'growth' | 'pro' | null) {
    if (!planKey) {
      // Pay As You Grow has no subscription (it's commission-only) — an
      // existing owner goes to Billing to turn on Stripe payouts, a signed-in
      // guest without a claimed business claims one, and a guest signs in first.
      if (session) { navigate(provider ? '/billing' : '/claim-business'); return; }
      navigate('/login');
      return;
    }
    if (!session) { navigate('/login'); return; }
    if (!provider) {
      setCheckoutError({ plan: planKey, message: 'Claim your business first, then come back to upgrade.' });
      return;
    }
    if (isCurrentPlan(planKey)) {
      // Already subscribed to this tier — nothing to check out, send them to
      // Billing instead of starting a Stripe session for the plan they have.
      navigate('/billing');
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
      <header className="relative flex items-center justify-between gap-3 px-4 py-4 border-b border-gray-100 sm:px-8">
        <div
          className="flex items-center gap-2 cursor-pointer"
          onClick={() => navigate('/')}
        >
          <BrandLogo className="h-9 sm:h-10" />
        </div>
        <nav className="hidden items-center gap-10 md:flex">
          <button onClick={() => navigate('/')} className="text-sm font-medium text-gray-700 hover:text-gray-900 pb-1">Home</button>
          <button className="text-sm font-medium text-[#FA4D8D] border-b-2 border-[#FA4D8D] pb-1">Plans</button>
          <button onClick={() => { navigate('/contact'); }} className="text-sm font-medium text-gray-700 hover:text-gray-900 pb-1">Contact</button>
        </nav>
        <div className="flex items-center gap-2 sm:gap-3">
          <Button variant="outline" onClick={() => navigate('/login')} className="rounded-full px-4 sm:px-6 border-gray-300 text-gray-700 hover:bg-gray-50">
            Sign in
          </Button>
          <Button onClick={() => navigate('/login')} className="hidden rounded-full px-6 bg-gradient-to-r from-[#FA4D8D] to-[#FF6B9B] text-white shadow-[0_8px_20px_rgba(250,93,147,0.32)] hover:brightness-105 border-0 sm:inline-flex">
            Upgrade your listing
          </Button>
          {/* Mobile menu toggle */}
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="Menu"
            aria-expanded={menuOpen}
            className="grid h-9 w-9 place-items-center rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 md:hidden"
          >
            {menuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>

        {/* Mobile dropdown */}
        {menuOpen && (
          <div className="absolute inset-x-0 top-full z-40 border-b border-gray-100 bg-white shadow-lg md:hidden">
            <nav className="flex flex-col px-4 py-1">
              <button onClick={() => { setMenuOpen(false); navigate('/'); }} className="py-3 text-center text-sm font-medium text-gray-700">Home</button>
              <button onClick={() => { setMenuOpen(false); navigate('/plans'); }} className="border-t border-gray-100 py-3 text-center text-sm font-semibold text-[#FA4D8D]">Plans</button>
              <button onClick={() => { setMenuOpen(false); navigate('/contact'); }} className="border-t border-gray-100 py-3 text-center text-sm font-medium text-gray-700">Contact</button>
              <button
                onClick={() => { setMenuOpen(false); navigate('/login'); }}
                className="my-2 rounded-full bg-gradient-to-r from-[#FA4D8D] to-[#FF6B9B] px-6 py-2.5 text-center text-sm font-semibold text-white"
              >
                Upgrade your listing
              </button>
            </nav>
          </div>
        )}
      </header>

      {/* Pricing Section */}
      <div className="max-w-5xl mx-auto px-8 py-12">
        {/* Header */}
        <div className="text-center mb-10">
          <h1 className="text-4xl font-bold text-[#111A4C] mb-3">Something for everyone</h1>
          <p className="text-gray-600">Choose a plan that enables your business to achieve it's goals.</p>
        </div>

        {/* Pricing Cards — all three boxes share the same height; the featured
            Pro card carries a "MOST POPULAR" badge overlapping its top border. */}
        <div className="grid gap-5 mb-10 md:grid-cols-3 items-stretch">
          {plans.map((plan) => {
            const card = (
              <div
                key={plan.name}
                className={cn(
                  'relative h-full rounded-2xl p-6 border bg-white flex flex-col text-center shadow-[0_4px_16px_rgba(17,26,76,0.06)]',
                  plan.featured
                    ? 'border-2 border-[#C7B1E6] bg-gradient-to-b from-[#C7B1E6]/10 to-white'
                    : 'border-gray-200'
                )}
              >
                {plan.featured && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <div className="flex items-center gap-1 whitespace-nowrap px-3 py-1 bg-purple-500 text-white text-xs font-semibold rounded-full">
                      <Star className="w-3 h-3" />
                      MOST POPULAR
                    </div>
                  </div>
                )}
                <h3 className={cn('text-lg font-bold mb-1', plan.color, (plan.name === 'PRO' || plan.name === 'PREMIUM') && '-translate-x-1.5')}>{plan.name}</h3>
                <div className="flex items-baseline justify-center gap-1 mb-2">
                  <span className={cn('text-sm font-medium', plan.color)}>SGD</span>
                  <span className={cn('font-extrabold', plan.color, plan.featured ? 'text-6xl' : 'text-5xl')}>
                    {plan.price}
                  </span>
                  <span className="text-gray-500 text-sm">/month</span>
                </div>
                {plan.yearlyPrice ? (
                  <p className="text-xs text-gray-500 mb-1">
                    or SGD <span className="text-gray-500 font-medium">{plan.yearlyPrice}</span>
                  </p>
                ) : (
                  <div className="mb-1" />
                )}
                {plan.commission && (
                  <p className="text-[13px] font-semibold text-[#FFB77A] mb-4">{plan.commission}</p>
                )}
                <ul className="mb-4 space-y-1.5 text-left flex-1">
                  {plan.perks.map((perk) => (
                    <li key={perk} className="flex gap-2 text-[12.5px] leading-5 text-gray-600">
                      <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-green-500" />
                      <span>{perk}</span>
                    </li>
                  ))}
                </ul>

                <Button
                  onClick={() => selectPlan(plan.planKey)}
                  disabled={plan.planKey !== null && checkoutBusy === plan.planKey}
                  className={cn('w-full rounded-xl py-3 font-semibold bg-white', plan.buttonClass)}
                  variant="outline"
                >
                  {plan.planKey !== null && checkoutBusy === plan.planKey
                    ? 'Redirecting to Stripe…'
                    : isCurrentPlan(plan.planKey)
                      ? 'Current plan'
                      : plan.buttonText}
                </Button>
                {checkoutError?.plan === plan.planKey && (
                  <p className="mt-2 text-xs font-medium text-red-400">{checkoutError.message}</p>
                )}
              </div>
            );

            return card;
          })}
        </div>

        {/* Comparison Table — four fixed columns don't fit a phone, so it
            scrolls sideways below its natural width rather than crushing the
            plan buttons into each other. */}
        <div className="border border-gray-200 rounded-xl overflow-x-auto">
          <div className="grid min-w-[600px] grid-cols-4 bg-gray-50 px-6 py-3 text-sm font-semibold text-gray-700">
            <div>Features</div>
            <div className="text-center text-blue-600">Pay as you grow</div>
            <div className="text-center text-purple-600">Pro</div>
            <div className="text-center text-pink-600">Premium</div>
          </div>
          {features.map((feature, idx) => (
            <div
              key={feature.name}
              className={cn(
                'grid min-w-[600px] grid-cols-4 px-6 py-3 text-sm items-center',
                idx % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'
              )}
            >
              <div className="text-gray-800 font-medium">{feature.name}</div>
              <div className="flex justify-center">
                {feature.grow ? (
                  <Check className="w-4 h-4 text-blue-400" />
                ) : (
                  <span className="text-gray-300">—</span>
                )}
              </div>
              <div className="flex justify-center">
                {feature.pro ? (
                  <Check className="w-4 h-4 text-purple-400" />
                ) : (
                  <span className="text-gray-300">—</span>
                )}
              </div>
              <div className="flex justify-center">
                {feature.premium ? (
                  <Check className="w-4 h-4 text-pink-400" />
                ) : (
                  <span className="text-gray-300">—</span>
                )}
              </div>
            </div>
          ))}
          <div className="grid min-w-[600px] grid-cols-4 items-stretch px-6 py-4 bg-white">
            <div />
            {plans.map((plan) => (
              <div key={plan.name} className="flex px-1">
                <Button
                  onClick={() => selectPlan(plan.planKey)}
                  disabled={plan.planKey !== null && checkoutBusy === plan.planKey}
                  className={cn('h-full w-full whitespace-normal rounded-xl px-2 py-2 text-center text-xs font-semibold leading-tight bg-white sm:text-sm', plan.buttonClass)}
                  variant="outline"
                >
                  {plan.planKey !== null && checkoutBusy === plan.planKey
                    ? 'Redirecting…'
                    : isCurrentPlan(plan.planKey)
                      ? 'Current plan'
                      : plan.buttonText}
                </Button>
              </div>
            ))}
          </div>
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
              <button
                onClick={() => setOptOutOpen(true)}
                className="text-sm font-semibold text-red-400 hover:text-red-500 underline underline-offset-4"
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
              {optOutError && <p className="mt-2 text-sm font-semibold text-red-400">{optOutError}</p>}
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
