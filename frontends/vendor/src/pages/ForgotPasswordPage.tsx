import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/auth/AuthProvider';
import { AuthHeader } from '@/components/AuthHeader';

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
    <div className="flex min-h-screen flex-col bg-gray-50">
      <AuthHeader>
        <Button
          variant="outline"
          onClick={() => navigate('/login')}
          className="rounded-full border-blue-300 bg-blue-50 px-4 text-blue-700 hover:bg-blue-100 sm:px-6"
        >
          Sign in
        </Button>
      </AuthHeader>
      <div className="flex flex-1 items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
        <h1 className="mb-1 text-xl font-bold text-gray-900">Reset your password</h1>
        {sent ? (
          <>
            <div className="mt-4 rounded-lg bg-green-50 px-3 py-3 text-sm font-medium text-green-700">
              If an account exists for <strong>{email}</strong>, we've sent a reset link. Check your inbox and spam folder.
            </div>
            <button className="mt-4 w-full text-center text-xs font-semibold text-[#A7D8F8]" onClick={() => navigate('/login')}>
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
              <button className="font-semibold text-[#A7D8F8]" onClick={() => navigate('/login')}>
                Log in
              </button>
            </p>
          </>
        )}
      </div>
      </div>
    </div>
  );
}
