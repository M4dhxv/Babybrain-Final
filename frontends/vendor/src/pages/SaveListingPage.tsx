import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Pencil,
  Store,
  Baby,
  MapPin,
  Clock,
  DollarSign,
  Link,
  Phone,
  Shield,
  CalendarDays,
  Lock,
  Bell,
  CheckCircle,
  Smartphone,
  Monitor,
  Heart,
  Star,
  MessageCircle,
  ChevronDown,
  Send,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/auth/AuthProvider';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import { BrandLogo } from '@/components/BrandLogo';

interface ListingRow {
  icon: typeof Store;
  label: string;
  value: string;
  color: string;
  bg: string;
}

interface VenueRow {
  name: string;
  address: string;
  hours: string;
}

const whyMatters = [
  { icon: Heart, text: 'Ensures accurate information for parents' },
  { icon: Shield, text: 'Builds trust and credibility for your business' },
  { icon: Heart, text: 'Helps parents discover and connect with you' },
  { icon: Bell, text: 'Keep your schedule and programmes up to date' },
];

export default function SaveListingPage() {
  const navigate = useNavigate();
  const { provider: activeProvider } = useAuth();
  const providerId = activeProvider?.id ?? null;
  const [previewMode, setPreviewMode] = useState<'mobile' | 'desktop'>('mobile');
  const [agreedVendor, setAgreedVendor] = useState(false);
  const [agreedBooking, setAgreedBooking] = useState(false);
  const [listingData, setListingData] = useState<ListingRow[]>([]);
  const [venues, setVenues] = useState<VenueRow[]>([]);

  // QA: the pencil icons did nothing because this page showed placeholder
  // copy. It now renders the business we actually hold, and every edit
  // control opens the real editor in the portal.
  useEffect(() => {
    if (!providerId) return;
    (async () => {
      const [{ data: provider }, { data: acts }, { data: locs }] = await Promise.all([
        supabase
          .from('providers')
          .select('business_name, vendor_category, address, postal_code, website, contact_email, contact_phone, whatsapp')
          .eq('id', providerId)
          .maybeSingle(),
        supabase
          .from('activities')
          .select('age_min_months, age_max_months, price, external_booking_url')
          .eq('provider_id', providerId)
          .eq('is_published', true),
        supabase
          .from('provider_locations')
          .select('name, address, postal_code, operating_hours')
          .eq('provider_id', providerId),
      ]);

      const activities = acts ?? [];
      const ageMin = activities.length ? Math.min(...activities.map((a) => a.age_min_months)) : null;
      const ageMax = activities.length ? Math.max(...activities.map((a) => a.age_max_months)) : null;
      const prices = activities.map((a) => Number(a.price)).filter((n) => Number.isFinite(n) && n > 0);
      const bookingLink = activities.find((a) => a.external_booking_url)?.external_booking_url ?? provider?.website ?? null;
      const months = (m: number) => (m < 24 ? `${m} months` : `${Math.round(m / 12)} years`);

      setListingData([
        { icon: Store, label: 'Business name', value: provider?.business_name ?? '—', color: 'text-purple-600', bg: 'bg-purple-100' },
        { icon: Baby, label: 'Category', value: provider?.vendor_category ?? 'Not set', color: 'text-pink-600', bg: 'bg-pink-100' },
        {
          icon: Baby,
          label: 'Age range',
          value: ageMin != null && ageMax != null ? `${months(ageMin)} – ${months(ageMax)}` : 'Not set',
          color: 'text-green-600',
          bg: 'bg-green-100',
        },
        {
          icon: DollarSign,
          label: 'Pricing',
          value: prices.length
            ? `From $${Math.min(...prices).toFixed(0)} per session`
            : 'Not set',
          color: 'text-yellow-600',
          bg: 'bg-yellow-100',
        },
        { icon: Link, label: 'Booking link', value: bookingLink ?? 'Not set', color: 'text-green-600', bg: 'bg-green-100' },
        {
          icon: Phone,
          label: 'Contact',
          value: [
            provider?.whatsapp || provider?.contact_phone ? `WhatsApp: ${provider.whatsapp ?? provider.contact_phone}` : null,
            provider?.contact_email ? `Email: ${provider.contact_email}` : null,
          ].filter(Boolean).join('  •  ') || 'Not set',
          color: 'text-blue-600',
          bg: 'bg-blue-100',
        },
      ]);

      setVenues(
        (locs ?? []).map((l) => {
          const hours = l.operating_hours as Record<string, [string, string][]> | null;
          const summary = hours
            ? Object.entries(hours)
                .map(([day, ranges]) => `${day[0].toUpperCase()}${day.slice(1)}: ${(ranges ?? []).map((r) => r.join(' – ')).join(', ')}`)
                .join('\n')
            : '';
          return {
            name: l.name,
            address: [l.address, l.postal_code].filter(Boolean).join(', '),
            hours: summary || 'Hours not set',
          };
        })
      );
    })();
  }, [providerId]);

  return (
    <div className="min-h-screen bg-white">
      {/* Header */}
      <header className="flex items-center justify-between px-8 py-4 border-b border-gray-100">
        <div className="flex items-center gap-2 cursor-pointer" onClick={() => navigate('/')}>
          <BrandLogo className="h-10" />
          
        </div>
        <Button variant="outline" onClick={() => navigate('/dashboard')} className="rounded-lg gap-2 border-gray-300 text-gray-700 hover:bg-gray-50">
          <ArrowLeft className="w-4 h-4" />
          Save & exit
        </Button>
      </header>

      {/* Content */}
      <div className="max-w-6xl mx-auto px-8 py-8">
        {/* Title */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-[#111A4C] mb-2">Save your listing</h1>
          <p className="text-gray-600">Double-check your details to help parents find and trust your venue.</p>
        </div>

        <div className="flex gap-8">
          {/* Left Sidebar */}
          <div className="w-56 flex-shrink-0">
            <img src={`${import.meta.env.BASE_URL}assets/asset_1.png`} alt="Brain" className="w-32 h-auto mb-4" />
            <h3 className="text-lg font-bold text-[#111A4C] mb-2">Almost there! <span className="text-lg">🚀</span></h3>
            <p className="text-sm text-gray-600 mb-6">Review your information before saving. You can edit anything if needed.</p>

            <div className="bg-pink-50 rounded-xl p-4">
              <h4 className="text-sm font-semibold text-[#C90044] mb-3">Why it matters</h4>
              <div className="space-y-3">
                {whyMatters.map((item, idx) => (
                  <div key={idx} className="flex gap-2">
                    <div className="w-6 h-6 rounded-full bg-white flex items-center justify-center flex-shrink-0">
                      <item.icon className="w-3 h-3 text-[#C90044]" />
                    </div>
                    <span className="text-xs text-gray-700">{item.text}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Center - Summary */}
          <div className="flex-1">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-gray-900">Summary of your listing</h3>
              <Button
                variant="outline"
                size="sm"
                onClick={() => navigate('/settings')}
                className="gap-1 text-xs rounded-lg border-gray-300"
              >
                <Pencil className="w-3 h-3" />
                Edit all
              </Button>
            </div>

            <div className="space-y-3">
              {listingData.map((item, idx) => (
                <div key={idx} className="flex items-start gap-3 p-3 bg-gray-50 rounded-xl">
                  <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0', item.bg)}>
                    <item.icon className={cn('w-4 h-4', item.color)} />
                  </div>
                  <div className="flex-1">
                    <div className="text-xs text-gray-500 mb-0.5">{item.label}</div>
                    <div className="text-sm text-gray-900 whitespace-pre-line">{item.value}</div>
                  </div>
                  <button
                    type="button"
                    aria-label={`Edit ${item.label}`}
                    onClick={() => navigate(item.label === 'Age range' || item.label === 'Pricing' || item.label === 'Booking link' ? '/activities' : '/settings')}
                    className="flex-shrink-0"
                  >
                    <Pencil className="w-4 h-4 text-gray-400 cursor-pointer hover:text-[#C90044]" />
                  </button>
                </div>
              ))}
            </div>

            {/* Venues & schedules — supports multiple locations */}
            <div className="mt-3 p-3 bg-gray-50 rounded-xl">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-lg bg-green-100 flex items-center justify-center flex-shrink-0">
                    <MapPin className="w-4 h-4 text-green-600" />
                  </div>
                  <div className="text-xs text-gray-500">
                    Venues &amp; schedules
                    {venues.length > 1 && (
                      <span className="ml-1 text-[#C90044] font-medium">· {venues.length} locations detected</span>
                    )}
                  </div>
                </div>
                <button type="button" aria-label="Edit venues & schedules" onClick={() => navigate('/activities?tab=locations')} className="flex-shrink-0">
                  <Pencil className="w-4 h-4 text-gray-400 cursor-pointer hover:text-gray-600" />
                </button>
              </div>
              <div className="space-y-2">
                {venues.map((v, i) => (
                  <div key={i} className="rounded-lg bg-white border border-gray-100 p-3">
                    <div className="text-sm font-semibold text-gray-900">{v.name}</div>
                    <div className="flex items-start gap-1.5 mt-1 text-xs text-gray-600">
                      <MapPin className="w-3.5 h-3.5 text-gray-400 mt-0.5 flex-shrink-0" />
                      <span>{v.address}</span>
                    </div>
                    <div className="flex items-start gap-1.5 mt-1 text-xs text-gray-600">
                      <Clock className="w-3.5 h-3.5 text-gray-400 mt-0.5 flex-shrink-0" />
                      <span className="whitespace-pre-line">{v.hours}</span>
                    </div>
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-gray-400 mt-2">
                Different activities can run at different venues &amp; times — add a venue for each location so parents see the right schedule.
              </p>
            </div>

            {/* Required to publish */}
            <div className="mt-6 p-4 border border-gray-200 rounded-xl">
              <div className="flex items-center gap-2 mb-3">
                <Shield className="w-5 h-5 text-[#C90044]" />
                <h4 className="font-semibold text-gray-900">Required to publish</h4>
              </div>
              <div className="flex items-start gap-3">
                <Checkbox
                  id="vendor-terms"
                  checked={agreedVendor}
                  onCheckedChange={(c) => setAgreedVendor(c === true)}
                  className="mt-0.5"
                />
                <div>
                  <label htmlFor="vendor-terms" className="text-sm text-gray-700 cursor-pointer">
                    I agree to the Vendor Terms
                  </label>
                  <p className="text-xs text-gray-500 mt-1">
                    Includes content ownership, child photo consent, PDPA obligations, review policy, platform rules and suspension & removal rights.
                  </p>
                </div>
                <span className="text-xs text-[#C90044] cursor-pointer flex-shrink-0">View terms</span>
              </div>
            </div>

            {/* Required for bookings */}
            <div className="mt-4 p-4 border border-gray-200 rounded-xl">
              <div className="flex items-center gap-2 mb-3">
                <CalendarDays className="w-5 h-5 text-green-600" />
                <h4 className="font-semibold text-gray-900">Required for bookings (Growth & Pro only)</h4>
              </div>
              <div className="flex items-start gap-3">
                <Checkbox
                  id="booking-terms"
                  checked={agreedBooking}
                  onCheckedChange={(c) => setAgreedBooking(c === true)}
                  className="mt-0.5"
                />
                <div>
                  <label htmlFor="booking-terms" className="text-sm text-gray-700 cursor-pointer">
                    I agree to the Booking & Messaging Terms
                  </label>
                  <p className="text-xs text-gray-500 mt-1">
                    Covers messaging rules, cancellation/rescheduling and refund policies.
                  </p>
                </div>
                <span className="text-xs text-[#C90044] cursor-pointer flex-shrink-0">View terms</span>
              </div>
            </div>
          </div>

          {/* Right - Preview */}
          <div className="w-80 flex-shrink-0">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-gray-900">Preview on BabyBrain.sg</h3>
            </div>
            <p className="text-xs text-gray-500 mb-4">This is how parents will see your venue.</p>

            {/* Mode Toggle */}
            <div className="flex gap-2 mb-4">
              <button
                onClick={() => setPreviewMode('mobile')}
                className={cn(
                  'flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',
                  previewMode === 'mobile' ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600'
                )}
              >
                <Smartphone className="w-3 h-3" />
                Mobile
              </button>
              <button
                onClick={() => setPreviewMode('desktop')}
                className={cn(
                  'flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',
                  previewMode === 'desktop' ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600'
                )}
              >
                <Monitor className="w-3 h-3" />
                Desktop
              </button>
            </div>

            {/* Phone Preview */}
            <div className="bg-gray-900 rounded-[2rem] p-3 shadow-xl">
              <div className="bg-white rounded-[1.5rem] overflow-hidden">
                {/* Image */}
                <div className="relative">
                  <img src={`${import.meta.env.BASE_URL}assets/asset_2.jpg`} alt="Preview" className="w-full h-36 object-cover" />
                  <div className="absolute top-3 right-3 w-8 h-8 bg-white/90 rounded-full flex items-center justify-center">
                    <Heart className="w-4 h-4 text-gray-600" />
                  </div>
                  <div className="absolute bottom-3 left-3 w-12 h-12 bg-white rounded-xl flex items-center justify-center shadow-md">
                    <span className="text-xs font-bold text-center leading-tight text-[#C90044]">Little<br/>Play</span>
                  </div>
                </div>
                {/* Info */}
                <div className="p-4">
                  <div className="flex items-center gap-2 mb-1">
                    <h4 className="font-bold text-gray-900">Little Play Studio</h4>
                    <CheckCircle className="w-4 h-4 text-blue-500" />
                  </div>
                  <p className="text-xs text-gray-500 mb-3">Playspaces  •  Indoor Playground</p>
                  <div className="flex items-center gap-3 mb-3">
                    <div className="flex items-center gap-1">
                      <Star className="w-3 h-3 text-yellow-400 fill-yellow-400" />
                      <span className="text-xs font-medium">4.8 (128)</span>
                    </div>
                    <div className="flex items-center gap-1 text-xs text-gray-500">
                      <MapPin className="w-3 h-3" />
                      Suntec City Mall
                    </div>
                    <span className="text-xs text-gray-500">$$</span>
                  </div>
                  <div className="flex flex-wrap gap-2 mb-3">
                    {['1 - 8 years', 'Indoor', 'Birthday Parties', 'Open Play'].map((tag) => (
                      <span key={tag} className="px-2 py-1 bg-purple-300 text-purple-800 text-xs rounded-full">
                        {tag}
                      </span>
                    ))}
                  </div>
                  <div className="flex items-center gap-2 mb-3">
                    <div className="flex items-center gap-1 px-2 py-1 bg-green-100 rounded-full">
                      <div className="w-1.5 h-1.5 bg-green-500 rounded-full" />
                      <span className="text-xs text-green-700">Open</span>
                    </div>
                    <span className="text-xs text-gray-500">Closes 6:00 PM</span>
                    <ChevronDown className="w-3 h-3 text-gray-400" />
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <button className="flex items-center justify-center gap-1 py-2 border border-green-300 rounded-lg text-xs text-green-700">
                      <MessageCircle className="w-3 h-3" />
                      WhatsApp
                    </button>
                    <button className="flex items-center justify-center gap-1 py-2 border border-gray-200 rounded-lg text-xs text-gray-700">
                      <Phone className="w-3 h-3" />
                      Call
                    </button>
                    <button className="flex items-center justify-center gap-1 py-2 border border-gray-200 rounded-lg text-xs text-gray-700">
                      <MapPin className="w-3 h-3" />
                      View on Map
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom Bar */}
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 px-8 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <Button
            variant="outline"
            onClick={() => navigate('/claim-business')}
            className="rounded-xl gap-2 border-gray-300 text-gray-700 hover:bg-gray-50"
          >
            <ArrowLeft className="w-4 h-4" />
            Back
          </Button>
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <Lock className="w-4 h-4" />
            Your information is secure and will never be shared.
          </div>
          <Button
            onClick={() => navigate('/dashboard')}
            className="gradient-primary text-white rounded-xl px-8 hover:opacity-90 gap-2"
          >
            Save
            <Send className="w-4 h-4" />
          </Button>
        </div>
      </div>

      <div className="h-20" />
    </div>
  );
}
