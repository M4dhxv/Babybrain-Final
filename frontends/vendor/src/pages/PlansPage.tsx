import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, X, Star } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const plans = [
  {
    name: 'FREE',
    price: '0',
    color: 'text-green-600',
    buttonText: 'Claim Listing',
    buttonVariant: 'outline' as const,
    buttonClass: 'border-green-500 text-green-600 hover:bg-green-50',
    featured: false,
  },
  {
    name: 'GROWTH',
    price: '99',
    color: 'text-[#E91E63]',
    buttonText: 'Start Growing',
    buttonVariant: 'default' as const,
    buttonClass: 'gradient-primary text-white hover:opacity-90',
    featured: true,
    badge: 'MOST POPULAR',
    yearlyPrice: '1,089/year (1 month free)',
  },
  {
    name: 'PRO',
    price: '199',
    color: 'text-purple-600',
    buttonText: 'Go Pro',
    buttonVariant: 'outline' as const,
    buttonClass: 'border-purple-500 text-purple-600 hover:bg-purple-50',
    featured: false,
  },
];

const features = [
  { name: 'Edit Profile & Upload Photos', free: true, growth: true, pro: true },
  { name: 'Website Traffic', free: true, growth: true, pro: true },
  { name: 'Reviews', free: true, growth: true, pro: true },
  { name: 'Messaging', free: false, growth: true, pro: true },
  { name: 'Booking & Waitlist Management', free: false, growth: true, pro: true },
  { name: 'Stripe Payments', free: false, growth: true, pro: true },
  { name: 'Package & Make-up Tokens', free: false, growth: true, pro: true },
  { name: 'Attendance Tracking', free: false, growth: true, pro: true },
  { name: 'Featured Placement', free: false, growth: false, pro: true },
  { name: 'Priority Ranking', free: false, growth: false, pro: true },
  { name: 'Email Promotions', free: false, growth: false, pro: true },
  { name: 'Advanced Analytics', free: false, growth: false, pro: true },
];

export default function PlansPage() {
  const navigate = useNavigate();
  const [optedOut, setOptedOut] = useState(false);

  return (
    <div className="min-h-screen bg-white">
      {/* Header */}
      <header className="flex items-center justify-between px-8 py-4 border-b border-gray-100">
        <div
          className="flex items-center gap-2 cursor-pointer"
          onClick={() => navigate('/')}
        >
          <img src={`${import.meta.env.BASE_URL}assets/logo-icon.png`} alt="BabyBrain" className="w-10 h-10" />
          <span className="text-2xl font-bold">
            <span className="text-[#E91E63]">Baby</span>
            <span className="text-[#9C27B0]">Brain</span>
            <span className="text-gray-600">.sg</span>
          </span>
        </div>
        <nav className="flex items-center gap-10">
          <button onClick={() => navigate('/')} className="text-sm font-medium text-gray-700 hover:text-gray-900 pb-1">Home</button>
          <button className="text-sm font-medium text-[#E91E63] border-b-2 border-[#E91E63] pb-1">Plans</button>
          <button className="text-sm font-medium text-gray-700 hover:text-gray-900 pb-1">Contact</button>
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
          <h1 className="text-4xl font-bold text-[#1B1F3B] mb-3">Simple pricing</h1>
          <p className="text-gray-600 mb-6">Choose the plan that fits your business.</p>
          <Button onClick={() => navigate('/login')} className="gradient-primary text-white px-8 py-3 rounded-xl text-sm font-semibold hover:opacity-90">
            Upgrade Your Listing
          </Button>
        </div>

        {/* Pricing Cards */}
        <div className="grid grid-cols-3 gap-6 mb-10">
          {plans.map((plan) => (
            <div
              key={plan.name}
              className={cn(
                'relative rounded-2xl p-6',
                plan.featured
                  ? 'border-2 border-[#E91E63] bg-gradient-to-b from-pink-50/50 to-white'
                  : 'border border-gray-200 bg-white'
              )}
            >
              {plan.badge && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                  <div className="flex items-center gap-1 px-3 py-1 bg-[#E91E63] text-white text-xs font-semibold rounded-full">
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
                {plan.yearlyPrice && (
                  <p className="text-xs text-gray-500 mb-4">
                    or SGD <span className="text-[#E91E63] font-medium">{plan.yearlyPrice}</span>
                  </p>
                )}
                {!plan.yearlyPrice && <div className="mb-4" />}

                <Button
                  onClick={() => navigate(plan.name === 'FREE' ? '/claim-business' : '/login')}
                  className={cn('w-full rounded-xl py-3 font-semibold', plan.buttonClass)}
                  variant={plan.buttonVariant}
                >
                  {plan.buttonText}
                </Button>
              </div>
            </div>
          ))}
        </div>

        {/* Comparison Table */}
        <div className="border border-gray-200 rounded-xl overflow-hidden">
          <div className="grid grid-cols-4 bg-gray-50 px-6 py-3 text-sm font-semibold text-gray-700">
            <div>Compare Plans</div>
            <div className="text-center text-green-600">Free</div>
            <div className="text-center text-[#E91E63]">Growth</div>
            <div className="text-center text-purple-600">Pro</div>
          </div>
          {features.map((feature, idx) => (
            <div
              key={feature.name}
              className={cn(
                'grid grid-cols-4 px-6 py-3 text-sm',
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
                {feature.growth ? (
                  <Check className="w-4 h-4 text-[#E91E63]" />
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

        {/* Opt out / remove listing */}
        <div className="mt-10 border-t border-gray-100 pt-6 text-center">
          {optedOut ? (
            <p className="text-sm text-gray-600">
              Request received — our team will remove your listing within 3 working days.
              You can re-list any time.
            </p>
          ) : (
            <>
              <p className="text-sm text-gray-500 mb-2">Don't want to be listed on BabyBrain?</p>
              <button
                onClick={() => {
                  if (window.confirm('Opt out and remove your listing from BabyBrain? Parents will no longer see your business.')) {
                    setOptedOut(true);
                  }
                }}
                className="text-sm font-semibold text-red-500 hover:text-red-600 underline underline-offset-4"
              >
                Opt out / remove my listing
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
