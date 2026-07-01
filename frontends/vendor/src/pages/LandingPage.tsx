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

export default function LandingPage() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-white">
      {/* Header */}
      <header className="flex items-center justify-between px-8 py-4 border-b border-gray-100">
        <div className="flex items-center gap-2">
          <img src={`${import.meta.env.BASE_URL}assets/logo-icon.png`} alt="BabyBrain" className="w-10 h-10" />
          <span className="text-2xl font-bold">
            <span className="text-[#E91E63]">Baby</span>
            <span className="text-[#9C27B0]">Brain</span>
            <span className="text-gray-600">.sg</span>
          </span>
        </div>
        <nav className="flex items-center gap-10">
          <button className="text-sm font-medium text-[#E91E63] border-b-2 border-[#E91E63] pb-1">Home</button>
          <button onClick={() => navigate('/plans')} className="text-sm font-medium text-gray-700 hover:text-gray-900 pb-1">Plans</button>
          <button className="text-sm font-medium text-gray-700 hover:text-gray-900 pb-1">Contact</button>
        </nav>
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            className="rounded-full px-6 border-gray-300 text-gray-700 hover:bg-gray-50"
          >
            Sign In
          </Button>
          <Button
            onClick={() => navigate('/plans')}
            className="rounded-full px-6 gradient-primary text-white hover:gradient-primary-hover border-0"
          >
            Upgrade your listing
          </Button>
        </div>
      </header>

      {/* Hero Section */}
      <section className="relative px-8 pt-10 pb-16">
        <div className="flex items-start gap-8 max-w-7xl mx-auto">
          {/* Left Content */}
          <div className="flex-1 pt-6">
            {/* Trust Badge */}
            <div className="inline-flex items-center gap-2 px-4 py-2 bg-pink-50 rounded-full mb-6 relative">
              <Shield className="w-4 h-4 text-[#E91E63]" />
              <span className="text-sm font-medium text-[#E91E63]">Join 500+ trusted providers</span>
              <Sparkles className="w-4 h-4 text-yellow-400 absolute -left-6 -top-2" />
              <Cloud className="w-5 h-5 text-purple-200 absolute -right-8 top-0" />
            </div>

            {/* Heading */}
            <h1 className="text-5xl font-extrabold text-[#1B1F3B] leading-tight mb-4">
              Bring More<br />
              <span className="text-[#E91E63]">Families</span><br />
              To You
            </h1>
            <Heart className="w-6 h-6 text-pink-300 inline-block ml-2 -mt-4" />

            {/* Subtitle */}
            <p className="text-gray-600 text-base leading-relaxed max-w-md mb-8">
              List your classes, play spaces and experiences in minutes and connect with thousands of parents looking for the best for their kids.
            </p>

            {/* Features */}
            <div className="space-y-4 mb-8">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-pink-100 flex items-center justify-center">
                  <Users className="w-4 h-4 text-[#E91E63]" />
                </div>
                <span className="text-sm font-medium text-gray-800">Reach targeted parent audience</span>
              </div>
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-yellow-100 flex items-center justify-center">
                  <TrendingUp className="w-4 h-4 text-yellow-600" />
                </div>
                <span className="text-sm font-medium text-gray-800">Boost visibility & bookings</span>
              </div>
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-green-100 flex items-center justify-center">
                  <CheckCircle className="w-4 h-4 text-green-600" />
                </div>
                <span className="text-sm font-medium text-gray-800">Verified & trusted platform</span>
              </div>
            </div>

            {/* CTAs */}
            <div className="flex items-center gap-4">
              <Button
                onClick={() => navigate('/plans')}
                className="gradient-primary text-white px-8 py-3 rounded-xl text-sm font-semibold hover:opacity-90"
              >
                Upgrade your listing
              </Button>
              <Button
                variant="outline"
                className="px-8 py-3 rounded-xl text-sm font-semibold border-[#E91E63] text-[#E91E63] hover:bg-pink-50"
              >
                Book a demo
              </Button>
            </div>
          </div>

          {/* Right Image */}
          <div className="flex-1 relative">
            <img
              src={`${import.meta.env.BASE_URL}assets/asset_1.jpg`}
              alt="Children playing in a ball pit"
              className="w-full h-auto rounded-3xl object-cover"
              style={{ maxHeight: '520px' }}
            />
          </div>
        </div>
      </section>

      {/* Stats Section */}
      <section className="bg-gray-50 py-10 px-8">
        <div className="max-w-5xl mx-auto grid grid-cols-3 gap-8">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-2xl bg-pink-100 flex items-center justify-center">
              <Users className="w-7 h-7 text-[#E91E63]" />
            </div>
            <div>
              <div className="text-3xl font-bold text-[#E91E63]">10K+</div>
              <div className="text-sm font-semibold text-gray-900">Parents</div>
              <div className="text-xs text-gray-500">reached every month</div>
            </div>
          </div>
          <div className="flex items-center gap-4 border-l border-r border-gray-200 px-8">
            <div className="w-14 h-14 rounded-2xl bg-yellow-100 flex items-center justify-center">
              <Store className="w-7 h-7 text-yellow-600" />
            </div>
            <div>
              <div className="text-3xl font-bold text-yellow-600">500+</div>
              <div className="text-sm font-semibold text-gray-900">Active Providers</div>
              <div className="text-xs text-gray-500">growing with us</div>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-2xl bg-green-100 flex items-center justify-center">
              <CalendarCheck className="w-7 h-7 text-green-600" />
            </div>
            <div>
              <div className="text-3xl font-bold text-green-600">75K+</div>
              <div className="text-sm font-semibold text-gray-900">Bookings facilitated</div>
              <div className="text-xs text-gray-500">every month</div>
            </div>
          </div>
        </div>
      </section>

      {/* Trust Banner */}
      <section className="bg-white py-4 px-8 border-t border-gray-100">
        <div className="max-w-5xl mx-auto flex items-center justify-center gap-2">
          <Heart className="w-4 h-4 text-pink-400" />
          <span className="text-sm text-gray-600">
            Trusted by playspaces, classes and event co-ordinators nationwide.
          </span>
          <Sparkles className="w-4 h-4 text-purple-400" />
        </div>
      </section>
    </div>
  );
}
