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
    <div className="min-h-screen bg-white overflow-x-hidden">
      {/* Header */}
      <header className="flex items-center justify-between gap-3 px-4 py-3 border-b border-gray-100 sm:px-8">
        <BrandLogo className="h-9 sm:h-10" />
        <nav className="hidden items-center gap-10 md:flex">
          <button className="text-sm font-medium text-[#FA4D8D] border-b-2 border-[#FA4D8D] pb-1">Home</button>
          <button onClick={() => navigate('/plans')} className="text-sm font-medium text-gray-700 hover:text-gray-900 pb-1">Plans</button>
          <button onClick={() => { window.location.href = 'mailto:hello@babybrain.sg'; }} className="text-sm font-medium text-gray-700 hover:text-gray-900 pb-1">Contact</button>
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

      {/* Hero Section */}
      <section className="relative px-4 pt-8 pb-10 sm:px-8 sm:pt-10 sm:pb-12">
        <div className="flex flex-col items-start gap-6 max-w-7xl mx-auto lg:flex-row lg:gap-8">
          {/* Left Content */}
          <div className="flex-1">
            {/* Trust Badge */}
            <div className="inline-flex items-center gap-2 px-4 py-2.5 bg-[#FED7E4] rounded-full mb-4 relative">
              <Shield className="w-4 h-4 text-[#FA4D8D]" />
              <span className="text-sm font-bold text-[#FA4D8D]">Join 500+ trusted providers</span>
              <Sparkles className="w-4 h-4 text-yellow-400 absolute -left-6 -top-2" />
              <Cloud className="w-5 h-5 text-purple-300 absolute -right-8 top-0" />
            </div>

            {/* Heading */}
            <h1 className="text-3xl font-extrabold text-[#111A4C] leading-tight mb-2 sm:text-4xl">
              Bring More <span className="text-[#FFC1D6]">Families</span> To You
            </h1>
            <Heart className="w-5 h-5 text-pink-300 inline-block -mt-1 mb-2" />

            {/* Subtitle */}
            <p className="text-gray-600 text-sm leading-relaxed max-w-lg mb-4">
              List your classes, play spaces and experiences in minutes and connect with thousands of parents looking for the best for their kids.
            </p>

            {/* Features */}
            <div className="flex flex-wrap gap-3 mb-4">
              <div className="flex items-center gap-2 rounded-full bg-[#FEEBF2] py-1.5 pl-1.5 pr-3">
                <div className="w-6 h-6 rounded-full bg-gradient-to-br from-[#FED7E4] to-[#FEEBF2] flex items-center justify-center flex-shrink-0">
                  <Users className="w-3.5 h-3.5 text-[#FA4D8D]" />
                </div>
                <span className="text-xs font-medium text-gray-800">Reach targeted parents</span>
              </div>
              <div className="flex items-center gap-2 rounded-full bg-yellow-50 py-1.5 pl-1.5 pr-3">
                <div className="w-6 h-6 rounded-full bg-yellow-100 flex items-center justify-center flex-shrink-0">
                  <TrendingUp className="w-3.5 h-3.5 text-yellow-600" />
                </div>
                <span className="text-xs font-medium text-gray-800">Boost visibility & bookings</span>
              </div>
              <div className="flex items-center gap-2 rounded-full bg-green-50 py-1.5 pl-1.5 pr-3">
                <div className="w-6 h-6 rounded-full bg-green-100 flex items-center justify-center flex-shrink-0">
                  <CheckCircle className="w-3.5 h-3.5 text-green-600" />
                </div>
                <span className="text-xs font-medium text-gray-800">Verified & trusted platform</span>
              </div>
            </div>

            {/* CTAs */}
            <div className="flex flex-wrap items-center gap-3 sm:gap-4">
              <Button
                onClick={() => navigate('/plans')}
                className="bg-gradient-to-r from-[#FA4D8D] to-[#FF6B9B] text-white px-8 py-2.5 rounded-xl text-sm font-semibold shadow-[0_8px_20px_rgba(250,93,147,0.32)] hover:brightness-105"
              >
                Upgrade your listing
              </Button>
              <Button
                onClick={() => navigate('/contact')}
                variant="outline"
                className="px-8 py-2.5 rounded-xl text-sm font-semibold border-[#FFC1D6] text-[#FFC1D6] hover:bg-[#FEEBF2]"
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
      <section className="bg-gray-50 py-6 px-4 sm:px-8">
        <div className="max-w-5xl mx-auto grid grid-cols-1 gap-4 sm:grid-cols-3 sm:gap-6">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-[#FED7E4] to-[#FEEBF2] flex items-center justify-center">
              <Users className="w-6 h-6 text-[#FA4D8D]" />
            </div>
            <div>
              <div className="text-2xl font-bold text-[#FA4D8D]">10K+</div>
              <div className="text-sm font-semibold text-gray-900">Parents</div>
              <div className="text-xs text-gray-500">reached every month</div>
            </div>
          </div>
          <div className="flex items-center gap-3 sm:border-l sm:border-r sm:border-gray-200 sm:px-6">
            <div className="w-12 h-12 rounded-2xl bg-yellow-100 flex items-center justify-center">
              <Store className="w-6 h-6 text-yellow-600" />
            </div>
            <div>
              <div className="text-2xl font-bold text-yellow-600">500+</div>
              <div className="text-sm font-semibold text-gray-900">Active Providers</div>
              <div className="text-xs text-gray-500">growing with us</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-2xl bg-green-100 flex items-center justify-center">
              <CalendarCheck className="w-6 h-6 text-green-600" />
            </div>
            <div>
              <div className="text-2xl font-bold text-green-600">75K+</div>
              <div className="text-sm font-semibold text-gray-900">Bookings facilitated</div>
              <div className="text-xs text-gray-500">every month</div>
            </div>
          </div>
        </div>
      </section>

      {/* Trust Banner */}
      <section className="bg-white py-3 px-8 border-t border-gray-100">
        <div className="max-w-5xl mx-auto flex items-center justify-center gap-2">
          <Heart className="w-4 h-4 text-pink-400" />
          <span className="text-sm text-gray-600">
            Trusted by playspaces, classes and event co-ordinators nationwide.
          </span>
          <Sparkles className="w-4 h-4 text-purple-400" />
        </div>
      </section>
      <SiteFooter />
    </div>
  );
}
