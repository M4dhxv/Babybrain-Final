import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/auth/AuthProvider';
import { BrandLogo } from '@/components/BrandLogo';

export default function LoginPage() {
  const navigate = useNavigate();
  const { signIn, session } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Already signed in? Go straight to the dashboard.
  useEffect(() => {
    if (session) navigate('/dashboard');
  }, [session, navigate]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await signIn(email, password);
    setBusy(false);
    if (error) {
      setError(error);
      return;
    }
    navigate('/dashboard');
  }

  return (
    <div className="flex min-h-screen flex-col bg-gray-50">
      {/* Marketing header over the sign-in card. Mirrors the landing-page nav
          but drops the parent site's "Explore Activities" link and search bar —
          neither belongs on the vendor portal. */}
      <header className="flex items-center justify-between gap-3 border-b border-gray-100 bg-white px-4 py-3 sm:px-8 md:grid md:grid-cols-[1fr_auto_1fr]">
        <button onClick={() => navigate('/')} aria-label="BabyBrain home" className="justify-self-start">
          <BrandLogo className="h-9 sm:h-10" />
        </button>
        <nav className="hidden items-center gap-10 md:flex">
          <button onClick={() => navigate('/')} className="text-sm font-medium text-gray-700 hover:text-gray-900 pb-1">
            Home
          </button>
          <button onClick={() => navigate('/plans')} className="text-sm font-medium text-gray-700 hover:text-gray-900 pb-1">
            Plans
          </button>
          <button onClick={() => navigate('/contact')} className="text-sm font-medium text-gray-700 hover:text-gray-900 pb-1">
            Contact
          </button>
        </nav>
        <div className="flex items-center justify-self-end gap-2 sm:gap-3">
          <Button
            variant="outline"
            onClick={() => navigate('/login')}
            className="rounded-full px-4 sm:px-6 border-gray-300 text-gray-700 hover:bg-gray-50"
          >
            Log in
          </Button>
          <Button
            onClick={() => navigate('/claim-business')}
            className="rounded-full px-6 border-0 bg-gradient-to-r from-[#FA4D8D] to-[#FF6B9B] text-white shadow-[0_8px_20px_rgba(250,93,147,0.32)] transition hover:brightness-105"
          >
            Sign up
          </Button>
        </div>
      </header>

      <div className="flex flex-1 items-center justify-center px-4 py-10">
        <div className="w-full max-w-sm rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
          <h1 className="mb-1 text-xl font-bold text-gray-900">Welcome back 👋</h1>
          <p className="mb-6 text-sm text-gray-500">Sign in to manage your business.</p>
          {error && (
            <div className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
              {error}
            </div>
          )}
          <form onSubmit={submit} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="password">Password</Label>
                <button type="button" className="text-xs font-semibold text-[#0E6FAF]" onClick={() => navigate('/forgot-password')}>
                  Forgot password?
                </button>
              </div>
              <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </div>
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
          <p className="mt-4 text-center text-xs text-gray-500">
            New here?{' '}
            <button className="font-semibold text-[#0E6FAF]" onClick={() => navigate('/claim-business')}>
              Claim your business
            </button>
          </p>
        </div>
      </div>
    </div>
  );
}
