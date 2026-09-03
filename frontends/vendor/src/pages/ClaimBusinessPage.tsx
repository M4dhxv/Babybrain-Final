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

interface ClaimableBusiness {
  id: string;
  business_name: string;
  address: string | null;
  postal_code: string | null;
  region: string | null;
  vendor_category: string | null;
  activity_count: number;
}

const whyVerify = [
  { icon: MapPin, title: 'Claim your business listing', desc: 'Take ownership of your business on BabyBrain.' },
  { icon: Pencil, title: 'Update business information', desc: 'Keep your details, photos and programmes up to date.' },
  { icon: CalendarDays, title: 'Take bookings & payments', desc: 'Let parents book and pay through BabyBrain — included on the Pay as you grow plan.' },
  { icon: MessageCircle, title: 'Chat with parents', desc: 'Respond to enquiries with live in-app messaging — included on the Pro plan.' },
  { icon: Bell, title: 'Manage schedules & availability', desc: 'Easily manage your activities, schedule and packages.' },
];

const REGION_LABELS: Record<string, string> = {
  central: 'Central', east: 'East', 'north-east': 'North-East',
  north: 'North', west: 'West', sentosa: 'Sentosa',
};

export default function ClaimBusinessPage() {
  const navigate = useNavigate();
  const { session, signIn } = useAuth();

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ClaimableBusiness[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [selected, setSelected] = useState<ClaimableBusiness | null>(null);

  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [uen, setUen] = useState('');

  const [claimId, setClaimId] = useState<string | null>(null);
  const [phoneChannel, setPhoneChannel] = useState<string>('not_requested');
  const [emailCode, setEmailCode] = useState('');
  const [phoneCode, setPhoneCode] = useState('');
  const [emailVerified, setEmailVerified] = useState(false);

  /* QA 21/08: "once you enter the verification code it takes you to log in but
     no password has been set — flow doesn't work." A claimer has no account
     yet and the portal has no sign-up form, so the old redirect to /login was
     a dead end. The password is collected here instead, right after the code,
     and the account is created against the address the code went to. */
  const [needsPassword, setNeedsPassword] = useState(false);
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  /* The code's email already has a BabyBrain login. Rather than bounce to
     /login (where nothing knew to finish the claim), the owner signs in right
     here and we re-run verification with the session — the route then hands
     over ownership on that second post. `password` doubles as the field here;
     the panels are mutually exclusive. */
  const [needsSignIn, setNeedsSignIn] = useState(false);
  /* The code check alone sets `emailVerified` (it drives the status panel), but
     a signed-out claimer still has no account at that point. `claimComplete`
     is the real "you can move on now" signal — set only once the business has
     actually been handed over — so the footer "Continue" can't fling them at a
     login page for an account that was never created. */
  const [claimComplete, setClaimComplete] = useState(false);

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
      setResults((data ?? []) as unknown as ClaimableBusiness[]);
    }, 300);
    return () => clearTimeout(t);
  }, [query]);

  async function sendCodes() {
    if (!selected) return setError('Find and select your business first.');
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

  /**
   * Checks the code, and — when the claimer has no account — creates one with
   * the password they set, signs them in, and lands them on their listing.
   * `withPassword` is only sent on the second pass, so a signed-in vendor
   * never sees the password step at all.
   */
  async function verify(withPassword?: string) {
    if (!claimId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiPost<{
        verified: boolean; claimed: boolean; next?: string;
        email?: string; account_created?: boolean;
      }>('/api/vendor/claim/verify', {
        claim_id: claimId,
        email_code: emailCode,
        phone_code: phoneCode || undefined,
        ...(withPassword ? { password: withPassword } : {}),
      });
      setEmailVerified(res.verified);

      if (res.next === 'set_password') {
        setNeedsPassword(true);
        setNotice('Code confirmed. Set a password to finish claiming this business.');
        return;
      }
      if (res.next === 'sign_in') {
        // The code's email already has a login. Finish by signing in here — no
        // detour to /login, which had no idea a claim was waiting.
        setNeedsPassword(false);
        setNeedsSignIn(true);
        setPassword('');
        setNotice(
          `${res.email ?? email.trim()} already has a BabyBrain log-in. Enter its password to finish claiming this business.`
        );
        return;
      }
      if (res.claimed) {
        // A freshly-created account needs signing in so /save-listing loads as
        // its owner. An existing owner reaching here is already signed in (the
        // sign_in step below did it), so there's nothing to do.
        if (res.account_created && withPassword && res.email) {
          const { error: signInError } = await signIn(res.email, withPassword);
          if (signInError) {
            setNeedsPassword(false);
            setNotice(null);
            setError(`Your business is claimed and your log-in is ready, but signing you in failed: ${signInError}. Please log in with ${res.email}.`);
            return;
          }
        }
        setNeedsPassword(false);
        setNeedsSignIn(false);
        setClaimComplete(true);
        navigate('/save-listing');
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : 'That code could not be verified.';
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  async function submitPassword() {
    if (password.length < 8) return setError('Choose a password of at least 8 characters.');
    if (password !== password2) return setError('Those passwords don’t match.');
    await verify(password);
  }

  /**
   * Existing-owner path: sign the vendor in against the address the code was
   * sent to, then re-run verification. The route now sees a session (and no
   * password), so it hands over ownership and returns `claimed: true` — which
   * `verify()` turns into the redirect to /save-listing.
   */
  async function submitSignIn() {
    const addr = email.trim();
    if (!password) return setError('Enter your password to continue.');
    setBusy(true);
    setError(null);
    try {
      const { error: signInError } = await signIn(addr, password);
      if (signInError) {
        setError(`That didn’t match — ${signInError}`);
        return;
      }
      await verify();
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
          Log in
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
          <p className="text-gray-600">Search your business on BabyBrain and verify ownership to get started.</p>
        </div>

        <div className="flex flex-col gap-8 lg:flex-row">
          <div className="w-full flex-shrink-0 lg:w-64">
            {/* The artwork is a square raster on a cream ground. `multiply` drops its
                near-white ground into the page and the mask feathers the four edges, so it
                sits on the white column with no visible picture frame. */}
            <img
              src={`${import.meta.env.BASE_URL}assets/playcentre-illustration.webp`}
              alt=""
              className="-mt-6 mb-2 h-auto w-full max-w-60 mix-blend-multiply mx-auto lg:mx-0 lg:-mt-8 min-[1060px]:-mt-16"
              style={{
                WebkitMaskImage:
                  'radial-gradient(ellipse 80% 80% at 50% 50%, #000 74%, transparent 100%)',
                maskImage:
                  'radial-gradient(ellipse 80% 80% at 50% 50%, #000 74%, transparent 100%)',
              }}
            />
            {/* Centred on a phone to line up with the page heading above it;
                left-aligned again from lg, where this is a side column. */}
            <h3 className="mb-4 text-center text-lg font-bold text-[#FA4D8D] lg:text-left">Why verify your business?</h3>
            {/* Centred on a phone, the icon sits above the text rather than
                beside it. Centring an icon-and-text row as a unit left the
                icons at a different x on every row — and a long label pushed
                one of them off the edge of the column entirely. */}
            <div className="space-y-6 lg:space-y-4">
              {whyVerify.map((item) => (
                <div
                  key={item.title}
                  className="flex flex-col items-center gap-2 text-center lg:flex-row lg:items-start lg:gap-3 lg:text-left"
                >
                  <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-pink-50 lg:mt-0.5">
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
            {/* Step 1 — find the business */}
            <div className="flex-1">
              <div className="mb-4 flex items-center gap-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-pink-100 text-sm font-bold text-[#FA4D8D]">1</div>
                <div>
                  <h3 className="font-semibold text-gray-900">Find your business</h3>
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
                {results.map((business) => {
                  const on = selected?.id === business.id;
                  return (
                    <button
                      type="button"
                      key={business.id}
                      onClick={() => setSelected(business)}
                      className={cn(
                        'flex w-full items-start gap-4 rounded-xl border-2 p-3 text-left transition-colors',
                        on ? 'border-[#FA4D8D] bg-pink-50/50' : 'border-gray-200 hover:border-gray-300'
                      )}
                    >
                      <div className="flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <h4 className="font-semibold text-gray-900">{business.business_name}</h4>
                          {on && <CheckCircle className="h-5 w-5 flex-shrink-0 text-[#FA4D8D]" />}
                        </div>
                        {(business.address || business.postal_code) && (
                          <div className="mt-1 flex items-start gap-1 text-xs text-gray-500">
                            <MapPin className="mt-0.5 h-3 w-3 flex-shrink-0" />
                            <span>{[business.address, business.postal_code].filter(Boolean).join(', ')}</span>
                          </div>
                        )}
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {business.region && (
                            <span className="rounded-full bg-purple-100 px-2 py-0.5 text-xs text-purple-700">
                              {REGION_LABELS[business.region] ?? business.region}
                            </span>
                          )}
                          <span className="rounded-full bg-pink-100 px-2 py-0.5 text-xs text-[#FA4D8D]">
                            {business.activity_count} {business.activity_count === 1 ? 'listing' : 'listings'}
                          </span>
                        </div>
                      </div>
                    </button>
                  );
                })}
                {searched && !searching && results.length === 0 && (
                  <p className="rounded-xl bg-gray-50 p-4 text-sm text-gray-500">
                    No unclaimed businesses matched “{query.trim()}”. It may already be claimed, or not listed yet.
                  </p>
                )}
                {query.trim().length < 2 && (
                  <p className="rounded-xl bg-gray-50 p-4 text-sm text-gray-500">Type at least two characters to search.</p>
                )}
              </div>

              <p className="text-sm text-gray-500">
                Can't find your business?{' '}
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
                  Select your business on the left to continue.
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
                ) : needsSignIn ? (
                  /* The code's email already has a login. Sign in here and the
                     claim finishes on the spot — no trip to /login. */
                  <div className="rounded-xl border border-gray-200 p-4">
                    <h4 className="text-sm font-semibold text-gray-900">Sign in to finish claiming</h4>
                    <p className="mt-1 text-xs text-gray-500">
                      <span className="font-medium text-gray-700">{email.trim()}</span> already has a BabyBrain log-in.
                    </p>
                    <label className="mt-3 block text-sm font-semibold text-gray-900" htmlFor="claim-signin-password">Password</label>
                    <Input
                      id="claim-signin-password"
                      type="password"
                      autoComplete="current-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Your BabyBrain password"
                      className="mt-2 rounded-xl border-gray-200"
                    />
                    <Button
                      onClick={submitSignIn}
                      disabled={busy || !password}
                      className="gradient-primary mt-4 w-full rounded-xl text-white hover:opacity-90"
                    >
                      {busy ? 'Finishing…' : 'Finish claiming this business'}
                    </Button>
                    <button
                      type="button"
                      onClick={() => navigate('/forgot-password')}
                      className="mt-3 w-full text-center text-xs font-semibold text-[#A7D8F8]"
                    >
                      Forgot your password?
                    </button>
                  </div>
                ) : needsPassword ? (
                  /* Final step for a claimer with no BabyBrain account. The
                     code has already proved they hold this mailbox, so all
                     that's left is the password. */
                  <div className="rounded-xl border border-gray-200 p-4">
                    <h4 className="text-sm font-semibold text-gray-900">Create your partner log-in</h4>
                    <p className="mt-1 text-xs text-gray-500">
                      You'll sign in with <span className="font-medium text-gray-700">{email.trim()}</span>.
                    </p>
                    <label className="mt-3 block text-sm font-semibold text-gray-900" htmlFor="claim-password">Password</label>
                    <Input
                      id="claim-password"
                      type="password"
                      autoComplete="new-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="At least 8 characters"
                      className="mt-2 rounded-xl border-gray-200"
                    />
                    <label className="mt-3 block text-sm font-semibold text-gray-900" htmlFor="claim-password-2">Confirm password</label>
                    <Input
                      id="claim-password-2"
                      type="password"
                      autoComplete="new-password"
                      value={password2}
                      onChange={(e) => setPassword2(e.target.value)}
                      placeholder="Type it again"
                      className="mt-2 rounded-xl border-gray-200"
                    />
                    <Button
                      onClick={submitPassword}
                      disabled={busy || password.length < 8 || password !== password2}
                      className="gradient-primary mt-4 w-full rounded-xl text-white hover:opacity-90"
                    >
                      {busy ? 'Finishing…' : 'Finish claiming this business'}
                    </Button>
                    <button
                      type="button"
                      onClick={() => {
                        setNeedsPassword(false);
                        setNeedsSignIn(true);
                        setPassword('');
                        setPassword2('');
                        setError(null);
                        setNotice(`Enter the password for ${email.trim()} to finish claiming this business.`);
                      }}
                      className="mt-3 w-full text-center text-xs font-semibold text-[#A7D8F8]"
                    >
                      Already have a BabyBrain log-in? Sign in instead
                    </button>
                  </div>
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
                      <Button onClick={() => verify()} disabled={emailCode.length !== 6 || busy} className="gradient-primary flex-1 rounded-xl text-white hover:opacity-90">
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
            onClick={() => {
              // Whatever step the claimer is on, the footer finishes it here —
              // never by handing off to a login page that can't complete it.
              if (!claimComplete && needsSignIn) return void submitSignIn();
              if (!claimComplete && needsPassword) return void submitPassword();
              navigate('/save-listing');
            }}
            disabled={
              !(
                claimComplete ||
                (session && emailVerified) ||
                (needsPassword && password.length >= 8 && password === password2) ||
                (needsSignIn && password.length > 0)
              ) || busy
            }
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
