import { useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth, type AuthIssue } from '@/auth/AuthProvider';
import { AuthHeader } from '@/components/AuthHeader';
import { AuthFieldAction, AuthFieldMessage, AuthHelpLine } from '@/components/AuthFieldMessage';
import { suggestEmail } from '@/lib/emailTypo';

export default function ForgotPasswordPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const expired = new URLSearchParams(location.search).has('expired');
  const { resetPassword } = useAuth();
  // Carried over from the sign-in page's "Forgot password?" link.
  const [email, setEmail] = useState(() => (location.state as { email?: string } | null)?.email ?? '');
  const [error, setError] = useState<string | null>(null);
  const [issue, setIssue] = useState<AuthIssue | null>(null);
  // The email the issue was about — the field may have been edited since.
  const [issueEmail, setIssueEmail] = useState('');
  const [failures, setFailures] = useState(0);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setIssue(null);
    const result = await resetPassword(email);
    setBusy(false);
    if (!result.error) {
      setSent(true);
      return;
    }
    setFailures((n) => n + 1);
    if (result.issue) {
      setIssue(result.issue);
      setIssueEmail(email.trim());
      emailRef.current?.select();
    } else {
      setError(result.error);
    }
  }

  function applyEmail(next: string) {
    setEmail(next);
    setIssue(null);
    emailRef.current?.focus();
  }

  const suggestion = issue?.kind === 'unknown_email' ? suggestEmail(issueEmail) : null;

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
      <div className="flex flex-1 items-start justify-center px-4 py-10 sm:items-center">
      <div className="w-full max-w-sm rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
        <h1 className="mb-1 text-xl font-bold text-gray-900">Reset your password</h1>
        {sent ? (
          <>
            <div className="mt-4 rounded-lg bg-green-50 px-3 py-3 text-sm font-medium text-green-700">
              We've sent a reset link to <strong>{email}</strong>. Check your inbox and spam folder.
            </div>
            <button className="mt-4 w-full text-center text-xs font-semibold text-[#A7D8F8]" onClick={() => navigate('/login')}>
              ← Back to sign in
            </button>
          </>
        ) : (
          <>
            {expired && (
              <div className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800">
                That link has expired or was already used. Enter your email for a fresh one, or sign in if you've already set your password.
              </div>
            )}
            <p className="mb-6 text-sm text-gray-500">Enter your email and we'll send you a link to set a new password.</p>
            {error && (
              <div role="alert" className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-700">{error}</div>
            )}
            <form onSubmit={submit} className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  ref={emailRef}
                  id="email"
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    if (issue) setIssue(null);
                  }}
                  aria-invalid={issue?.kind === 'unknown_email' || undefined}
                  className={issue?.kind === 'unknown_email' ? 'border-red-400 focus-visible:border-red-400 focus-visible:ring-red-200' : undefined}
                  aria-describedby={issue ? 'email-issue' : undefined}
                  required
                />
                {issue?.kind === 'unknown_email' && (
                  <AuthFieldMessage
                    id="email-issue"
                    actions={suggestion && <AuthFieldAction onClick={() => applyEmail(suggestion)}>Use {suggestion}</AuthFieldAction>}
                  >
                    {suggestion ? (
                      <><strong>{issueEmail}</strong> isn't registered. Did you mean <strong>{suggestion}</strong>?</>
                    ) : (
                      <><strong>{issueEmail}</strong> isn't registered with BabyBrain. Please check the email and try again.</>
                    )}
                  </AuthFieldMessage>
                )}
                {issue?.kind === 'contact_email' && (
                  <AuthFieldMessage
                    id="email-issue"
                    tone="warn"
                    actions={<AuthFieldAction onClick={() => applyEmail('')}>Enter the login email</AuthFieldAction>}
                  >
                    <strong>{issueEmail}</strong> is {issue.businessName}'s contact email, not a login, so there's no password to reset.{' '}
                    {issue.loginHint ? (
                      <>Request the link for your login email, <strong>{issue.loginHint}</strong>.</>
                    ) : (
                      <>Request the link for the owner's login email.</>
                    )}
                  </AuthFieldMessage>
                )}
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
            {failures >= 2 && <AuthHelpLine />}
          </>
        )}
      </div>
      </div>
    </div>
  );
}
