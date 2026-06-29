import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Search,
  MapPin,
  CheckCircle,
  Mail,
  Phone,
  CreditCard,
  Lock,
  ArrowLeft,
  ArrowRight,
  Pencil,
  CalendarDays,
  MessageCircle,
  Bell,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

const venues = [
  {
    id: 1,
    name: 'MelodyHaus – Novena',
    address: '12 Thomson Road, Singapore 307606',
    tag: 'Music Classes',
    image: '/assets/venue-music.jpg',
  },
  {
    id: 2,
    name: 'MelodyHaus – Katong',
    address: '88 East Coast Road, Singapore 428788',
    tag: 'Music Classes',
    image: '/assets/venue-music.jpg',
  },
  {
    id: 3,
    name: 'MelodyHaus – Bukit Timah',
    address: '1 Jalan Anak Bukit, Singapore 588996',
    tag: 'Music Classes',
    image: '/assets/venue-music.jpg',
  },
];

const whyVerify = [
  { icon: MapPin, title: 'Claim your venue listing', desc: 'Take ownership of your business on BabyBrain.' },
  { icon: Pencil, title: 'Update venue information', desc: 'Keep your details, photos and programs up to date.' },
  { icon: CalendarDays, title: 'Receive bookings directly', desc: 'Parents can book and pay through BabyBrain.' },
  { icon: MessageCircle, title: 'Respond to parent enquiries', desc: 'Chat with parents and build lasting relationships.' },
  { icon: Bell, title: 'Manage schedules & availability', desc: 'Easily manage your classes, timetable and holidays.' },
];

export default function ClaimBusinessPage() {
  const navigate = useNavigate();
  const [selectedVenue, setSelectedVenue] = useState<number | null>(1);
  const [email, setEmail] = useState('hello@melodyhaus.com');
  const [phone, setPhone] = useState('+65 9123 4567');
  const [uen, setUen] = useState('');
  const [emailSent, setEmailSent] = useState(false);
  const [smsSent, setSmsSent] = useState(false);

  return (
    <div className="min-h-screen bg-white">
      {/* Header */}
      <header className="flex items-center justify-between px-8 py-4 border-b border-gray-100">
        <div className="flex items-center gap-2 cursor-pointer" onClick={() => navigate('/')}>
          <img src="/assets/logo-icon.png" alt="BabyBrain" className="w-10 h-10" />
          <span className="text-2xl font-bold">
            <span className="text-[#E91E63]">Baby</span>
            <span className="text-[#9C27B0]">Brain</span>
            <span className="text-gray-600">.sg</span>
          </span>
        </div>
        <Button variant="outline" className="rounded-lg gap-2 border-gray-300 text-gray-700 hover:bg-gray-50">
          <ArrowLeft className="w-4 h-4" />
          Save & Exit
        </Button>
      </header>

      {/* Content */}
      <div className="max-w-6xl mx-auto px-8 py-8">
        {/* Title */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-[#1B1F3B] mb-2">Claim Your Business</h1>
          <p className="text-gray-600">Search for your venue on BabyBrain and verify ownership to get started.</p>
        </div>

        <div className="flex gap-8">
          {/* Left Sidebar */}
          <div className="w-64 flex-shrink-0">
            <img src="/assets/shop-illustration.png" alt="Shop" className="w-40 h-auto mb-4" />
            <h3 className="text-lg font-bold text-[#E91E63] mb-4">Why verify your business?</h3>
            <div className="space-y-4">
              {whyVerify.map((item) => (
                <div key={item.title} className="flex gap-3">
                  <div className="w-8 h-8 rounded-full bg-pink-50 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <item.icon className="w-4 h-4 text-[#E91E63]" />
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-gray-900">{item.title}</div>
                    <div className="text-xs text-gray-500">{item.desc}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Main Content */}
          <div className="flex-1 flex gap-6">
            {/* Step 1: Find Venue */}
            <div className="flex-1">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-8 h-8 rounded-full bg-pink-100 text-[#E91E63] flex items-center justify-center text-sm font-bold">1</div>
                <div>
                  <h3 className="font-semibold text-gray-900">Find Your Venue</h3>
                  <p className="text-xs text-gray-500">Search and select your venue from our existing listings.</p>
                </div>
              </div>

              {/* Search */}
              <div className="relative mb-4">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <Input
                  placeholder="Search venue name or location"
                  className="pl-10 rounded-xl border-gray-200"
                />
              </div>

              {/* Venue List */}
              <div className="space-y-3 mb-4">
                {venues.map((venue) => (
                  <div
                    key={venue.id}
                    onClick={() => setSelectedVenue(venue.id)}
                    className={cn(
                      'flex items-center gap-4 p-3 rounded-xl border-2 cursor-pointer transition-colors',
                      selectedVenue === venue.id
                        ? 'border-[#E91E63] bg-pink-50/50'
                        : 'border-gray-200 hover:border-gray-300'
                    )}
                  >
                    <img src={venue.image} alt={venue.name} className="w-20 h-16 rounded-lg object-cover" />
                    <div className="flex-1">
                      <div className="flex items-center justify-between">
                        <h4 className="font-semibold text-gray-900">{venue.name}</h4>
                        {selectedVenue === venue.id && (
                          <CheckCircle className="w-5 h-5 text-[#E91E63]" />
                        )}
                      </div>
                      <div className="flex items-center gap-1 text-xs text-gray-500 mt-1">
                        <MapPin className="w-3 h-3" />
                        {venue.address}
                      </div>
                      <span className="inline-block mt-2 px-2 py-0.5 bg-pink-100 text-[#E91E63] text-xs rounded-full">
                        {venue.tag}
                      </span>
                    </div>
                  </div>
                ))}
              </div>

              <p className="text-sm text-gray-500">
                Can't find your venue? <span className="text-[#E91E63] cursor-pointer">Contact our support</span>
              </p>
            </div>

            {/* Step 2: Verify Ownership */}
            <div className="flex-1">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-8 h-8 rounded-full bg-purple-100 text-purple-600 flex items-center justify-center text-sm font-bold">2</div>
                <div>
                  <h3 className="font-semibold text-gray-900">Verify Ownership</h3>
                  <p className="text-xs text-gray-500">We'll send verification codes to make sure you're the rightful owner.</p>
                </div>
              </div>

              {/* Business Email */}
              <div className="mb-4">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-8 h-8 rounded-lg bg-pink-100 flex items-center justify-center">
                    <Mail className="w-4 h-4 text-[#E91E63]" />
                  </div>
                  <div>
                    <label className="text-sm font-semibold text-gray-900">Business Email <span className="text-[#E91E63]">*</span></label>
                    <p className="text-xs text-gray-500">We'll send a code to your business email.</p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Input
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="rounded-xl border-gray-200 flex-1"
                  />
                  <Button
                    onClick={() => setEmailSent(true)}
                    className="gradient-primary text-white rounded-xl hover:opacity-90"
                  >
                    Send Code
                  </Button>
                </div>
              </div>

              {/* Business Phone */}
              <div className="mb-4">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-8 h-8 rounded-lg bg-green-100 flex items-center justify-center">
                    <Phone className="w-4 h-4 text-green-600" />
                  </div>
                  <div>
                    <label className="text-sm font-semibold text-gray-900">Business Phone <span className="text-[#E91E63]">*</span></label>
                    <p className="text-xs text-gray-500">We'll send an SMS code to your business phone.</p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Input
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    className="rounded-xl border-gray-200 flex-1"
                  />
                  <Button
                    onClick={() => setSmsSent(true)}
                    className="bg-green-500 text-white rounded-xl hover:bg-green-600"
                  >
                    Send SMS Code
                  </Button>
                </div>
              </div>

              {/* UEN */}
              <div className="mb-4">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-8 h-8 rounded-lg bg-yellow-100 flex items-center justify-center">
                    <CreditCard className="w-4 h-4 text-yellow-600" />
                  </div>
                  <div>
                    <label className="text-sm font-semibold text-gray-900">UEN (business registration number) <span className="text-[#E91E63]">*</span></label>
                    <p className="text-xs text-gray-500">Used to verify your registered business.</p>
                  </div>
                </div>
                <Input
                  value={uen}
                  onChange={(e) => setUen(e.target.value)}
                  placeholder="e.g. 202312345W"
                  className="rounded-xl border-gray-200"
                />
              </div>

              {/* Verification Status */}
              <div className="bg-green-50 rounded-xl p-4">
                <h4 className="text-sm font-semibold text-gray-900 mb-3 text-center">Verification Status</h4>
                <div className="grid grid-cols-2 gap-4">
                  <div className="text-center">
                    <div className="flex items-center justify-center gap-2 mb-1">
                      <CheckCircle className={cn('w-5 h-5', emailSent ? 'text-green-500' : 'text-gray-300')} />
                      <span className="text-sm font-medium text-gray-900">Email</span>
                    </div>
                    <p className="text-xs text-gray-500">{emailSent ? 'Verified' : 'Not verified yet'}</p>
                  </div>
                  <div className="text-center border-l border-green-200">
                    <div className="flex items-center justify-center gap-2 mb-1">
                      <CheckCircle className={cn('w-5 h-5', smsSent ? 'text-green-500' : 'text-gray-300')} />
                      <span className="text-sm font-medium text-gray-900">Phone</span>
                    </div>
                    <p className="text-xs text-gray-500">{smsSent ? 'Verified' : 'Not verified yet'}</p>
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
            onClick={() => navigate('/')}
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
            onClick={() => navigate('/save-listing')}
            className="gradient-primary text-white rounded-xl px-8 hover:opacity-90 gap-2"
          >
            Continue
            <ArrowRight className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {/* Spacer for fixed bottom bar */}
      <div className="h-20" />
    </div>
  );
}
