import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/auth/AuthProvider';

export default function LoginPage() {
  const navigate = useNavigate();
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
        <div className="mb-6 flex items-center gap-2">
          <img src={`${import.meta.env.BASE_URL}assets/logo-icon.png`} alt="BabyBrain" className="h-8 w-8 rounded-full" />
          <div>
            <div className="text-lg font-bold text-[#2b7cff]">BabyBrain</div>
            <div className="text-xs text-gray-500">Vendor Portal</div>
          </div>
        </div>
        <h1 className="mb-1 text-xl font-bold text-gray-900">Welcome back</h1>
        <p className="mb-6 text-sm text-gray-500">Sign in to manage your business.</p>
        {error && (
          <div className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
            {error}
          </div>
        )}
        <form onSubmit={submit} className="space-y-4">
          <div>
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div>
            <Label htmlFor="password">Password</Label>
            <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign In'}
          </Button>
        </form>
        <p className="mt-4 text-center text-xs text-gray-500">
          New here?{' '}
          <button className="font-semibold text-[#2b7cff]" onClick={() => navigate('/claim-business')}>
            Claim your business
          </button>
        </p>
      </div>
    </div>
  );
}
