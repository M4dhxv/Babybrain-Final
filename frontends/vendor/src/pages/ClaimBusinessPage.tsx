import { useEffect, useState } from 'react';
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
  Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { supabase } from '@/lib/supabase';
import { apiPost } from '@/lib/api';
import { useAuth } from '@/auth/AuthProvider';
import SiteFooter from '@/components/SiteFooter';
import { AuthHeader } from '@/components/AuthHeader';

/**
 * Claim Your Business.
 *
 * QA found this page was a mock: the search box did nothing, "Send Code" only
 * flipped a tick, and nothing was ever verified. It now searches the real
 * provider list and drives the /api/vendor/claim/* endpoints.
 */

interface ClaimableVenue {
  id: string;
  business_name: string;
  address: string | null;
  postal_code: string | null;
  region: string | null;
  vendor_category: string | null;
  activity_count: number;
}

const whyVerify = [
  { icon: MapPin, title: 'Claim your venue listing', desc: 'Take ownership of your business on BabyBrain.' },
  { icon: Pencil, title: 'Update venue information', desc: 'Keep your details, photos and programs up to date.' },
  { icon: CalendarDays, title: 'Take bookings & payments', desc: 'Let parents book and pay through BabyBrain — included on the Growth plan.' },
  { icon: MessageCircle, title: 'Chat with parents', desc: 'Respond to enquiries with live in-app messaging — included on the Growth plan.' },
  { icon: Bell, title: 'Manage schedules & availability', desc: 'Easily manage your activities, timetable and holidays.' },
];

const REGION_LABELS: Record<string, string> = {
  central: 'Central', east: 'East', 'north-east': 'North-East',
  north: 'North', west: 'West', sentosa: 'Sentosa',
};

export default function ClaimBusinessPage() {
  const navigate = useNavigate();
  const { session } = useAuth();

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ClaimableVenue[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [selected, setSelected] = useState<ClaimableVenue | null>(null);

  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [uen, setUen] = useState('');

  const [claimId, setClaimId] = useState<string | null>(null);
  const [phoneChannel, setPhoneChannel] = useState<string>('not_requested');
  const [emailCode, setEmailCode] = useState('');
  const [phoneCode, setPhoneCode] = useState('');
  const [emailVerified, setEmailVerified] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Debounced search against the claimable-provider function.
  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) {
      setResults([]);
      setSearched(false);
      return;
    }
    setSearching(true);
    const t = setTimeout(async () => {
      const { data, error: err } = await supabase.rpc('search_claimable_providers', {
        p_query: term,
        p_limit: 10,
      });
      setSearching(false);
      setSearched(true);
      if (err) {
        setError('Search is unavailable right now — please try again.');
        return;
      }
      setResults((data ?? []) as unknown as ClaimableVenue[]);
    }, 300);
    return () => clearTimeout(t);
  }, [query]);

  async function sendCodes() {
    if (!selected) return setError('Find and select your venue first.');
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await apiPost<{ claim_id: string; phone_channel: string; expires_in_minutes: number }>(
        '/api/vendor/claim/start',
        { provider_id: selected.id, email, phone, uen }
      );
      setClaimId(res.claim_id);
      setPhoneChannel(res.phone_channel);
      setNotice(
        `We've emailed a 6-digit code to ${email}. It expires in ${res.expires_in_minutes} minutes.` +
          (res.phone_channel === 'unavailable'
            ? ' SMS isn’t switched on yet, so verify by email for now.'
            : '')
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send your code.');
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    if (!claimId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiPost<{ verified: boolean; claimed: boolean; next?: string }>(
        '/api/vendor/claim/verify',
        { claim_id: claimId, email_code: emailCode, phone_code: phoneCode || undefined }
      );
      setEmailVerified(res.verified);
      if (res.claimed) {
        navigate('/save-listing');
      } else if (res.next === 'sign_in') {
        setNotice('Code confirmed. Create your partner log-in to finish claiming this business.');
        navigate('/login?claim=1');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That code could not be verified.');
    } finally {
      setBusy(false);
    }
  }

  const canSendCodes = Boolean(selected && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim()) && uen.trim());

  return (
    <div className="min-h-screen bg-white">
      <AuthHeader>
        <Button
          variant="outline"
          onClick={() => navigate('/login')}
          className="rounded-full border-blue-300 bg-blue-50 px-4 text-blue-700 hover:bg-blue-100 sm:px-6"
        >
          Login
        </Button>
        <Button
          variant="outline"
          onClick={() => navigate('/')}
          className="gap-2 rounded-full border-blue-300 px-4 text-blue-700 hover:bg-blue-50 sm:px-6"
        >
          <ArrowLeft className="h-4 w-4" />
          Save &amp; exit
        </Button>
      </AuthHeader>

      <div className="mx-auto max-w-6xl px-6 py-8 sm:px-8">
        <div className="mb-8 text-center">
          <h1 className="mb-2 text-3xl font-bold text-[#111A4C]">Claim your business</h1>
          <p className="text-gray-600">Search for your venue on BabyBrain and verify ownership to get started.</p>
        </div>

        <div className="flex flex-col gap-8 lg:flex-row">
          <div className="w-full flex-shrink-0 lg:w-64">
            <img src={`${import.meta.env.BASE_URL}assets/shop-illustration.png`} alt="" className="mb-4 h-auto w-40" />
            <h3 className="mb-4 text-lg font-bold text-[#FA4D8D]">Why verify your business?</h3>
            <div className="space-y-4">
              {whyVerify.map((item) => (
                <div key={item.title} className="flex gap-3">
                  <div className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-pink-50">
                    <item.icon className="h-4 w-4 text-[#FA4D8D]" />
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-gray-900">{item.title}</div>
                    <div className="text-xs text-gray-500">{item.desc}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="flex flex-1 flex-col gap-6 md:flex-row">
            {/* Step 1 — find the venue */}
            <div className="flex-1">
              <div className="mb-4 flex items-center gap-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-pink-100 text-sm font-bold text-[#FA4D8D]">1</div>
                <div>
                  <h3 className="font-semibold text-gray-900">Find your venue</h3>
                  <p className="text-xs text-gray-500">Search our listings by business name, address or postcode.</p>
                </div>
              </div>

              <div className="relative mb-4">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                {searching && <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-gray-300" />}
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="e.g. Lucy Sparkles, Muckypups, 427664"
                  className="rounded-xl border-gray-200 pl-10"
                />
              </div>

              <div className="mb-4 space-y-3">
                {results.map((venue) => {
                  const on = selected?.id === venue.id;
                  return (
                    <button
                      type="button"
                      key={venue.id}
                      onClick={() => setSelected(venue)}
                      className={cn(
                        'flex w-full items-start gap-4 rounded-xl border-2 p-3 text-left transition-colors',
                        on ? 'border-[#FA4D8D] bg-pink-50/50' : 'border-gray-200 hover:border-gray-300'
                      )}
                    >
                      <div className="flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <h4 className="font-semibold text-gray-900">{venue.business_name}</h4>
                          {on && <CheckCircle className="h-5 w-5 flex-shrink-0 text-[#FA4D8D]" />}
                        </div>
                        {(venue.address || venue.postal_code) && (
                          <div className="mt-1 flex items-start gap-1 text-xs text-gray-500">
                            <MapPin className="mt-0.5 h-3 w-3 flex-shrink-0" />
                            <span>{[venue.address, venue.postal_code].filter(Boolean).join(', ')}</span>
                          </div>
                        )}
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {venue.region && (
                            <span className="rounded-full bg-purple-100 px-2 py-0.5 text-xs text-purple-700">
                              {REGION_LABELS[venue.region] ?? venue.region}
                            </span>
                          )}
                          <span className="rounded-full bg-pink-100 px-2 py-0.5 text-xs text-[#FA4D8D]">
                            {venue.activity_count} {venue.activity_count === 1 ? 'listing' : 'listings'}
                          </span>
                        </div>
                      </div>
                    </button>
                  );
                })}
                {searched && !searching && results.length === 0 && (
                  <p className="rounded-xl bg-gray-50 p-4 text-sm text-gray-500">
                    No unclaimed venues matched “{query.trim()}”. It may already be claimed, or not listed yet.
                  </p>
                )}
                {query.trim().length < 2 && (
                  <p className="rounded-xl bg-gray-50 p-4 text-sm text-gray-500">Type at least two characters to search.</p>
                )}
              </div>

              <p className="text-sm text-gray-500">
                Can't find your venue?{' '}
                <button type="button" onClick={() => navigate('/contact')} className="cursor-pointer text-[#FA4D8D]">
                  Contact our support
                </button>
              </p>
            </div>

            {/* Step 2 — verify ownership */}
            <div className="flex-1">
              <div className="mb-4 flex items-center gap-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-purple-100 text-sm font-bold text-purple-600">2</div>
                <div>
                  <h3 className="font-semibold text-gray-900">Verify ownership</h3>
                  <p className="text-xs text-gray-500">We'll send a code to make sure you're the rightful owner.</p>
                </div>
              </div>

              {!selected && (
                <p className="mb-4 rounded-xl bg-gray-50 p-4 text-sm text-gray-500">
                  Select your venue on the left to continue.
                </p>
              )}

              <div className={cn('space-y-4', !selected && 'pointer-events-none opacity-50')}>
                <div>
                  <div className="mb-2 flex items-center gap-2">
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-pink-100">
                      <Mail className="h-4 w-4 text-[#FA4D8D]" />
                    </div>
                    <div>
                      <label className="text-sm font-semibold text-gray-900">Business email <span className="text-[#FA4D8D]">*</span></label>
                      <p className="text-xs text-gray-500">We'll send your code here.</p>
                    </div>
                  </div>
                  <Input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@yourbusiness.com"
                    className="rounded-xl border-gray-200"
                  />
                </div>

                <div>
                  <div className="mb-2 flex items-center gap-2">
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-green-100">
                      <Phone className="h-4 w-4 text-green-600" />
                    </div>
                    <div>
                      <label className="text-sm font-semibold text-gray-900">Business phone</label>
                      <p className="text-xs text-gray-500">Optional — helps us reach you faster.</p>
                    </div>
                  </div>
                  <Input
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="+65 9123 4567"
                    className="rounded-xl border-gray-200"
                  />
                </div>

                <div>
                  <div className="mb-2 flex items-center gap-2">
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-yellow-100">
                      <CreditCard className="h-4 w-4 text-yellow-600" />
                    </div>
                    <div>
                      <label className="text-sm font-semibold text-gray-900">UEN <span className="text-[#FA4D8D]">*</span></label>
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

                {!claimId ? (
                  <Button
                    onClick={sendCodes}
                    disabled={!canSendCodes || busy}
                    className="gradient-primary w-full rounded-xl text-white hover:opacity-90"
                  >
                    {busy ? 'Sending…' : 'Send verification code'}
                  </Button>
                ) : (
                  <div className="rounded-xl border border-gray-200 p-4">
                    <label className="text-sm font-semibold text-gray-900">Code from your email</label>
                    <Input
                      value={emailCode}
                      onChange={(e) => setEmailCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      inputMode="numeric"
                      placeholder="123456"
                      className="mt-2 rounded-xl border-gray-200 text-lg tracking-[0.3em]"
                    />
                    {phoneChannel === 'pending' && (
                      <>
                        <label className="mt-4 block text-sm font-semibold text-gray-900">Code from your phone</label>
                        <Input
                          value={phoneCode}
                          onChange={(e) => setPhoneCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                          inputMode="numeric"
                          placeholder="123456"
                          className="mt-2 rounded-xl border-gray-200 text-lg tracking-[0.3em]"
                        />
                      </>
                    )}
                    <div className="mt-4 flex gap-2">
                      <Button onClick={verify} disabled={emailCode.length !== 6 || busy} className="gradient-primary flex-1 rounded-xl text-white hover:opacity-90">
                        {busy ? 'Checking…' : 'Verify'}
                      </Button>
                      <Button variant="outline" onClick={() => { setClaimId(null); setEmailCode(''); setPhoneCode(''); }} className="rounded-xl">
                        Resend
                      </Button>
                    </div>
                  </div>
                )}

                {notice && <p className="rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-800">{notice}</p>}
                {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-700">{error}</p>}

                <div className="rounded-xl bg-green-50 p-4">
                  <h4 className="mb-3 text-center text-sm font-semibold text-gray-900">Verification status</h4>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="text-center">
                      <div className="mb-1 flex items-center justify-center gap-2">
                        <CheckCircle className={cn('h-5 w-5', emailVerified ? 'text-green-500' : 'text-gray-300')} />
                        <span className="text-sm font-medium text-gray-900">Email</span>
                      </div>
                      <p className="text-xs text-gray-500">{emailVerified ? 'Verified' : claimId ? 'Code sent' : 'Not verified yet'}</p>
                    </div>
                    <div className="border-l border-green-300 text-center">
                      <div className="mb-1 flex items-center justify-center gap-2">
                        <CheckCircle className="h-5 w-5 text-gray-300" />
                        <span className="text-sm font-medium text-gray-900">Phone</span>
                      </div>
                      <p className="text-xs text-gray-500">
                        {phoneChannel === 'unavailable' ? 'SMS coming soon' : phoneChannel === 'pending' ? 'Code sent' : 'Optional'}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="border-t border-gray-200 bg-white px-6 py-4 sm:px-8">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3">
          <Button variant="outline" onClick={() => navigate('/')} className="gap-2 rounded-xl border-gray-300 text-gray-700 hover:bg-gray-50">
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <Lock className="h-4 w-4" />
            Your information is secure and will never be shared.
          </div>
          <Button
            onClick={() => (session ? navigate('/save-listing') : navigate('/login?claim=1'))}
            disabled={!emailVerified}
            className="gradient-primary gap-2 rounded-xl px-8 text-white hover:opacity-90"
          >
            Continue
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <SiteFooter />
    </div>
  );
}
