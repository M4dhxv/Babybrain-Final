import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/auth/AuthProvider';

export default function ForgotPasswordPage() {
  const navigate = useNavigate();
  const { resetPassword } = useAuth();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await resetPassword(email);
    setBusy(false);
    if (error) {
      setError(error);
      return;
    }
    setSent(true);
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
        <h1 className="mb-1 text-xl font-bold text-gray-900">Reset your password</h1>
        {sent ? (
          <>
            <div className="mt-4 rounded-lg bg-green-50 px-3 py-3 text-sm font-medium text-green-700">
              If an account exists for <strong>{email}</strong>, we've sent a reset link. Check your inbox and spam folder.
            </div>
            <button className="mt-4 w-full text-center text-xs font-semibold text-[#2b7cff]" onClick={() => navigate('/login')}>
              ← Back to sign in
            </button>
          </>
        ) : (
          <>
            <p className="mb-6 text-sm text-gray-500">Enter your email and we'll send you a link to set a new password.</p>
            {error && (
              <div className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-700">{error}</div>
            )}
            <form onSubmit={submit} className="space-y-4">
              <div>
                <Label htmlFor="email">Email</Label>
                <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
              </div>
              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? 'Sending…' : 'Send reset link'}
              </Button>
            </form>
            <p className="mt-4 text-center text-xs text-gray-500">
              Remembered it?{' '}
              <button className="font-semibold text-[#2b7cff]" onClick={() => navigate('/login')}>
                Sign in
              </button>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
