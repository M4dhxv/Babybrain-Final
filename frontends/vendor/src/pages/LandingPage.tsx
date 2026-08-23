import { useNavigate } from 'react-router-dom';
import {
  Shield,
  Users,
  TrendingUp,
  CheckCircle,
  Store,
  CalendarCheck,
  Heart,
  Sparkles,
  Cloud,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import SiteFooter from '@/components/SiteFooter';
import { BrandLogo } from '@/components/BrandLogo';
import { HeroDashboardPreview } from '@/components/HeroDashboardPreview';

export default function LandingPage() {
  const navigate = useNavigate();

  return (
    <div className="bg-white overflow-x-hidden">
      {/* Header + fold: sized to fill exactly one viewport (min-h-screen)
          and kept separate from the footer below, so the footer's own
          height never eats into the free space this needs to center in —
          it always starts at or after the fold, however tall it is. */}
      <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between gap-3 px-4 py-3 border-b border-gray-100 sm:px-8">
        <BrandLogo className="h-9 sm:h-10" />
        <nav className="hidden items-center gap-10 md:flex">
          <button className="text-sm font-medium text-[#FA4D8D] border-b-2 border-[#FA4D8D] pb-1">Home</button>
          <button onClick={() => navigate('/plans')} className="text-sm font-medium text-gray-700 hover:text-gray-900 pb-1">Plans</button>
          <button onClick={() => navigate('/contact')} className="text-sm font-medium text-gray-700 hover:text-gray-900 pb-1">Contact</button>
        </nav>
        <div className="flex items-center gap-2 sm:gap-3">
          <Button
            variant="outline"
            onClick={() => navigate('/login')}
            className="rounded-full px-4 sm:px-6 border-gray-300 text-gray-700 hover:bg-gray-50"
          >
            Sign In
          </Button>
          <Button
            onClick={() => navigate('/plans')}
            className="hidden rounded-full px-6 bg-gradient-to-r from-[#FA4D8D] to-[#FF6B9B] text-white shadow-[0_8px_20px_rgba(250,93,147,0.32)] hover:brightness-105 transition border-0 sm:inline-flex"
          >
            Upgrade your listing
          </Button>
        </div>
      </header>

      {/* Fold — sized to exactly fill the space below the header and
          vertically centered, so the footer never peeks into view until
          the visitor actually scrolls. */}
      <div className="flex flex-1 flex-col justify-center">
      {/* Hero Section */}
      <section className="relative px-4 pt-3 pb-3 sm:px-8 sm:pt-4 sm:pb-4">
        <div className="flex flex-col items-start gap-6 max-w-7xl mx-auto lg:flex-row lg:gap-8">
          {/* Left Content */}
          <div className="flex-1">
            {/* Trust Badge */}
            <div className="inline-flex items-center gap-2 px-4 py-2.5 bg-[#FED7E4] rounded-full mb-3 relative">
              <Shield className="w-4 h-4 text-[#FA4D8D]" />
              <span className="text-sm font-bold text-[#FA4D8D]">Join 75+ trusted providers</span>
              <Sparkles className="w-4 h-4 text-yellow-400 absolute -left-6 -top-2" />
              <Cloud className="w-5 h-5 text-purple-300 absolute -right-8 top-0" />
            </div>

            {/* Heading */}
            <h1 className="text-4xl font-extrabold text-[#111A4C] leading-tight mb-2 sm:text-5xl">
              Bring More <span className="text-[#FFC1D6]">Families</span> To You
            </h1>
            <Heart className="w-6 h-6 text-pink-300 inline-block -mt-1 mb-2" />

            {/* Subtitle */}
            <p className="text-gray-600 text-base leading-relaxed max-w-lg mb-3">
              List your activities, play spaces, events and experiences with ease and connect with thousands of parents looking for the best activities for their little ones.
            </p>

            {/* Features */}
            <div className="space-y-2 mb-3">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-full bg-gradient-to-br from-[#FED7E4] to-[#FEEBF2] flex items-center justify-center flex-shrink-0">
                  <Users className="w-4.5 h-4.5 text-[#FA4D8D]" />
                </div>
                <span className="text-base font-medium text-gray-800">Reach a targeted audience</span>
              </div>
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-full bg-yellow-100 flex items-center justify-center flex-shrink-0">
                  <TrendingUp className="w-4.5 h-4.5 text-yellow-600" />
                </div>
                <span className="text-base font-medium text-gray-800">Boost visibility & bookings</span>
              </div>
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-full bg-green-100 flex items-center justify-center flex-shrink-0">
                  <CheckCircle className="w-4.5 h-4.5 text-green-600" />
                </div>
                <span className="text-base font-medium text-gray-800">Efficiently manage your business</span>
              </div>
            </div>

            {/* CTAs */}
            <div className="flex flex-wrap items-center gap-3 sm:gap-4">
              <Button
                onClick={() => navigate('/plans')}
                className="bg-gradient-to-r from-[#FA4D8D] to-[#FF6B9B] text-white px-9 py-3 rounded-xl text-base font-semibold shadow-[0_8px_20px_rgba(250,93,147,0.32)] hover:brightness-105"
              >
                Upgrade your listing
              </Button>
              <Button
                onClick={() => navigate('/contact')}
                variant="outline"
                className="px-9 py-3 rounded-xl text-base font-semibold border-[#FFC1D6] text-[#FFC1D6] hover:bg-[#FEEBF2]"
              >
                Enquire
              </Button>
            </div>
          </div>

          {/* Right Image */}
          <div className="flex-1 relative w-full">
            <HeroDashboardPreview />
          </div>
        </div>
      </section>

      {/* Stats Section */}
      <section className="bg-gray-50 py-3 px-4 sm:px-8">
        <div className="max-w-5xl mx-auto grid grid-cols-1 gap-5 sm:grid-cols-3 sm:gap-6">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-[#FED7E4] to-[#FEEBF2] flex items-center justify-center">
              <Users className="w-7 h-7 text-[#FA4D8D]" />
            </div>
            <div>
              <div className="text-3xl font-bold text-[#FA4D8D]">10K+</div>
              <div className="text-base font-semibold text-gray-900">Parents</div>
              <div className="text-sm text-gray-500">reached every month</div>
            </div>
          </div>
          <div className="flex items-center gap-4 sm:border-l sm:border-r sm:border-gray-200 sm:px-6">
            <div className="w-14 h-14 rounded-2xl bg-yellow-100 flex items-center justify-center">
              <Store className="w-7 h-7 text-yellow-600" />
            </div>
            <div>
              <div className="text-3xl font-bold text-yellow-600">75+</div>
              <div className="text-base font-semibold text-gray-900">Active providers</div>
              <div className="text-sm text-gray-500">growing with us</div>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-2xl bg-green-100 flex items-center justify-center">
              <CalendarCheck className="w-7 h-7 text-green-600" />
            </div>
            <div>
              <div className="text-3xl font-bold text-green-600">1000+</div>
              <div className="text-base font-semibold text-gray-900">Activities to book</div>
              <div className="text-sm text-gray-500">every month</div>
            </div>
          </div>
        </div>
      </section>

      {/* Trust Banner */}
      <section className="bg-white py-1.5 px-8 border-t border-gray-100">
        <div className="max-w-5xl mx-auto flex items-center justify-center gap-2">
          <Heart className="w-5 h-5 text-pink-400" />
          <span className="text-base text-gray-600">
            Trusted by playspaces, classes and event co-ordinators nationwide.
          </span>
          <Sparkles className="w-5 h-5 text-purple-400" />
        </div>
      </section>
      </div>
      </div>
      <div className="mt-8 sm:mt-12">
        <SiteFooter />
      </div>
    </div>
  );
}
