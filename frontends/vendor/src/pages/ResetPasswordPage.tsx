import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/auth/AuthProvider';
import { BrandLogo } from '@/components/BrandLogo';
import { supabase } from '@/lib/supabase';

export default function ResetPasswordPage() {
  const navigate = useNavigate();
  const { updatePassword, recovery, session } = useAuth();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  // Scanner-proof links carry a `token_hash` that is only spent here, on the
  // vendor's own click — Outlook/Defender pre-opening the link spends nothing.
  const tokenHash = new URLSearchParams(useLocation().search).get('token_hash');
  const [verified, setVerified] = useState(false);
  const [linkError, setLinkError] = useState(false);

  // The reset link must have produced a recovery session, otherwise there's
  // nothing to update.
  const ready = tokenHash ? verified : recovery || !!session;

  async function continueFromLink() {
    setBusy(true);
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash!, type: 'recovery' });
    setBusy(false);
    if (error) setLinkError(true);
    else setVerified(true);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) return setError("Passwords don't match.");
    if (password.length < 6) return setError('Use at least 6 characters.');
    setBusy(true);
    setError(null);
    const { error } = await updatePassword(password);
    setBusy(false);
    if (error) {
      setError(error);
      return;
    }
    setDone(true);
    setTimeout(() => navigate('/dashboard'), 1500);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
        <div className="mb-6">
          <BrandLogo className="h-8" />
        </div>
        <h1 className="mb-1 text-xl font-bold text-gray-900">Set a new password</h1>
        {done ? (
          <div className="mt-4 rounded-lg bg-green-50 px-3 py-3 text-sm font-medium text-green-700">
            Password updated. Taking you to your dashboard…
          </div>
        ) : tokenHash && !ready ? (
          linkError ? (
            <div className="mt-4 rounded-lg bg-amber-50 px-3 py-3 text-sm font-medium text-amber-700">
              That link has expired or was already used.{' '}
              <button className="font-semibold underline" onClick={() => navigate('/forgot-password')}>
                Request a new one
              </button>
              , or sign in if you've already set your password.
            </div>
          ) : (
            <>
              <p className="mb-6 text-sm text-gray-500">Continue to choose a new password for your account.</p>
              <Button className="w-full" onClick={continueFromLink} disabled={busy}>
                {busy ? 'Checking link…' : 'Continue'}
              </Button>
            </>
          )
        ) : !ready ? (
          <div className="mt-4 rounded-lg bg-amber-50 px-3 py-3 text-sm font-medium text-amber-700">
            This page only works from the reset link in your email. Open that link, or{' '}
            <button className="font-semibold underline" onClick={() => navigate('/forgot-password')}>
              request a new one
            </button>
            .
          </div>
        ) : (
          <>
            <p className="mb-6 text-sm text-gray-500">Choose a new password for your account.</p>
            {error && (
              <div className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-700">{error}</div>
            )}
            <form onSubmit={submit} className="space-y-4">
              <div>
                <Label htmlFor="password">New password</Label>
                <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
              </div>
              <div>
                <Label htmlFor="confirm">Confirm password</Label>
                <Input id="confirm" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
              </div>
              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? 'Saving…' : 'Update password'}
              </Button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
